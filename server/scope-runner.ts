import { AnthropicError } from "./anthropic-client";
import {
  assembleScope,
  clampRiskMargin,
  clearScopeDraft,
  generateScopeStep,
  getScopeConfig,
  loadScopeDraft,
  planScopeSteps,
  saveScope,
  saveScopeDraft,
  type ScopeGenParams,
  type ScopeSalesModel,
} from "./scope-service";
import { getSupabaseAdmin } from "./supabase";

const STEP_LOCK_MS = 90_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface ScopeStepRunResult {
  status: "running" | "done" | "error";
  processed: number;
  total: number;
  currentStepLabel?: string | null;
  error?: string;
  skipped?: boolean;
}

async function getDiscoveryText(projectId: string): Promise<string> {
  const admin = getSupabaseAdmin();
  const { data } = await admin
    .from("project_sources")
    .select("kind, discovery_text")
    .eq("project_id", projectId);
  return data?.find((s) => s.kind === "discovery")?.discovery_text ?? "";
}

async function getRunningScopeJob(projectId: string) {
  const admin = getSupabaseAdmin();
  const { data } = await admin
    .from("scope_jobs")
    .select("*")
    .eq("project_id", projectId)
    .eq("status", "running")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return data;
}

/**
 * Processa exatamente UM passo da geração de Escopo. Orquestrado pelo worker no
 * backend (Edge Function + cron), igual ao PRD e à análise.
 */
export async function runScopeStep(
  projectId: string,
  options: { force?: boolean } = {}
): Promise<ScopeStepRunResult> {
  const admin = getSupabaseAdmin();
  const job = await getRunningScopeJob(projectId);

  if (!job) {
    return { status: "error", processed: 0, total: 0, error: "Nenhuma geração de escopo em andamento." };
  }

  if (job.status === "done") {
    return {
      status: "done",
      processed: job.total_steps,
      total: job.total_steps,
      currentStepLabel: job.current_step_label,
    };
  }

  if (job.status === "error") {
    return {
      status: "error",
      processed: job.processed_steps,
      total: job.total_steps,
      error: job.error ?? "Erro ao gerar o escopo.",
      currentStepLabel: job.current_step_label,
    };
  }

  const { data: project } = await admin
    .from("projects")
    .select("name")
    .eq("id", projectId)
    .maybeSingle();

  if (!project?.name) {
    return { status: "error", processed: 0, total: 0, error: "Projeto não encontrado." };
  }

  const discovery = await getDiscoveryText(projectId);
  if (!discovery.trim()) {
    await admin
      .from("scope_jobs")
      .update({
        status: "error",
        error: "O Discovery deste projeto está vazio.",
        step_started_at: null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", job.id);
    return {
      status: "error",
      processed: job.processed_steps,
      total: job.total_steps,
      error: "O Discovery deste projeto está vazio.",
    };
  }

  const config = await getScopeConfig();
  const payload = (job.payload ?? {}) as {
    sales_model?: ScopeSalesModel;
    risk_margin?: number;
  };
  const salesModel: ScopeSalesModel =
    payload.sales_model === "banco_horas" ? "banco_horas" : "fechado";
  const riskMargin = clampRiskMargin(payload.risk_margin);
  const finalizeOptions = { riskMargin, salesModel };
  const params: ScopeGenParams = {
    discovery,
    productName: project.name,
    salesModel,
  };
  const steps = planScopeSteps(discovery);
  const totalSteps = steps.length;
  const idx = job.processed_steps as number;

  if (job.total_steps !== totalSteps) {
    await admin.from("scope_jobs").update({ total_steps: totalSteps }).eq("id", job.id);
  }

  if (idx >= totalSteps) {
    const draft = await loadScopeDraft(projectId);
    const scope = assembleScope(draft, config, finalizeOptions);
    scope.generated_at = new Date().toISOString();
    await saveScope(projectId, scope);
    await clearScopeDraft(projectId);
    await admin
      .from("scope_jobs")
      .update({
        status: "done",
        step_started_at: null,
        current_step_label: null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", job.id);
    return { status: "done", processed: totalSteps, total: totalSteps };
  }

  const stepStartedAt = job.step_started_at as string | null | undefined;
  if (!options.force && stepStartedAt) {
    const elapsed = Date.now() - new Date(stepStartedAt).getTime();
    if (elapsed < STEP_LOCK_MS) {
      const step = steps[idx];
      return {
        status: "running",
        processed: idx,
        total: totalSteps,
        currentStepLabel: step?.label ?? job.current_step_label,
        skipped: true,
      };
    }
  }

  const now = new Date().toISOString();
  const { data: claimed } = await admin
    .from("scope_jobs")
    .update({ step_started_at: now, updated_at: now })
    .eq("id", job.id)
    .eq("status", "running")
    .eq("processed_steps", idx)
    .select("id")
    .maybeSingle();

  if (!claimed && !options.force) {
    const step = steps[idx];
    return {
      status: "running",
      processed: idx,
      total: totalSteps,
      currentStepLabel: step?.label ?? job.current_step_label,
      skipped: true,
    };
  }

  const step = steps[idx];

  try {
    let draft = await loadScopeDraft(projectId);

    if (step.deterministic) {
      // Passo final: consolida tudo que foi acumulado.
      const scope = assembleScope(draft, config, finalizeOptions);
      scope.generated_at = new Date().toISOString();
      await saveScope(projectId, scope);
      await clearScopeDraft(projectId);
      await admin
        .from("scope_jobs")
        .update({
          status: "done",
          processed_steps: idx + 1,
          current_step_label: null,
          step_started_at: null,
          updated_at: new Date().toISOString(),
        })
        .eq("id", job.id);
      return { status: "done", processed: idx + 1, total: totalSteps };
    }

    let modules: ReturnType<typeof assembleScope>["modules"] | null = null;
    let lastError: Error | null = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        modules = await generateScopeStep(params, step.id, draft, config);
        lastError = null;
        break;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        if (attempt < 1) await sleep(2000);
      }
    }

    if (lastError || modules == null) {
      throw lastError ?? new Error("Falha ao mapear módulos do escopo.");
    }

    draft = [...draft, ...modules];
    await saveScopeDraft(projectId, draft);

    const processed = idx + 1;
    const nextStep = steps[processed];
    await admin
      .from("scope_jobs")
      .update({
        processed_steps: processed,
        current_step_label: nextStep?.label ?? null,
        step_started_at: null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", job.id);

    return {
      status: "running",
      processed,
      total: totalSteps,
      currentStepLabel: nextStep?.label ?? null,
    };
  } catch (error) {
    const message =
      error instanceof AnthropicError
        ? error.message
        : error instanceof Error
          ? error.message
          : "Erro ao gerar o escopo.";

    await admin
      .from("scope_jobs")
      .update({
        status: "error",
        error: message,
        step_started_at: null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", job.id);

    return {
      status: "error",
      processed: idx,
      total: totalSteps,
      error: message,
      currentStepLabel: step.label,
    };
  }
}
