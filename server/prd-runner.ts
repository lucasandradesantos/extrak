import { AnthropicError } from "./anthropic-client";
import { readGaps } from "./analysis-runner";
import {
  assemblePrd,
  clearPrdDraftSections,
  generatePrdStep,
  loadPrdDraftSections,
  planPrdSteps,
  savePrdDraftSections,
  type PrdGenParams,
} from "./prd-service";
import { getSupabaseAdmin } from "./supabase";

const STEP_LOCK_MS = 90_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface PrdStepRunResult {
  status: "running" | "done" | "error";
  processed: number;
  total: number;
  currentStepLabel?: string | null;
  prd?: string;
  error?: string;
  skipped?: boolean;
}

async function getSourceTexts(projectId: string) {
  const admin = getSupabaseAdmin();
  const { data } = await admin
    .from("project_sources")
    .select("kind, discovery_text")
    .eq("project_id", projectId);

  const discovery =
    data?.find((s) => s.kind === "discovery")?.discovery_text ?? "";
  const prototype =
    data?.find((s) => s.kind === "prototype")?.discovery_text ?? null;
  return { discovery, prototype };
}

async function getLatestAnalysisId(projectId: string): Promise<string | null> {
  const admin = getSupabaseAdmin();
  const { data } = await admin
    .from("analyses")
    .select("id")
    .eq("project_id", projectId)
    .order("round", { ascending: false })
    .limit(1)
    .maybeSingle();
  return data?.id ?? null;
}

async function loadPrdGenParams(projectId: string, productName: string): Promise<PrdGenParams> {
  const { discovery, prototype } = await getSourceTexts(projectId);
  const analysisId = await getLatestAnalysisId(projectId);
  const gaps = analysisId ? await readGaps(analysisId) : [];
  const respostas: Record<string, string> = {};
  for (const gap of gaps) {
    if (gap.resposta?.trim()) respostas[gap.id] = gap.resposta.trim();
  }
  return { discovery, prototype, gaps, respostas, productName };
}

async function getRunningPrdJob(projectId: string) {
  const admin = getSupabaseAdmin();
  const { data } = await admin
    .from("prd_jobs")
    .select("*")
    .eq("project_id", projectId)
    .eq("status", "running")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return data;
}

/**
 * Processa exatamente UM passo da geração de PRD. Orquestrado pelo worker no
 * backend (Edge Function + cron), igual à análise da IA.
 */
export async function runPrdStep(
  projectId: string,
  options: { force?: boolean } = {}
): Promise<PrdStepRunResult> {
  const admin = getSupabaseAdmin();
  const job = await getRunningPrdJob(projectId);

  if (!job) {
    return { status: "error", processed: 0, total: 0, error: "Nenhuma geração de PRD em andamento." };
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
      error: job.error ?? "Erro ao gerar o PRD.",
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

  const params = await loadPrdGenParams(projectId, project.name);
  if (!params.discovery.trim()) {
    await admin
      .from("prd_jobs")
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

  const steps = planPrdSteps(params.discovery);
  const totalSteps = steps.length;
  const idx = job.processed_steps as number;

  if (job.total_steps !== totalSteps) {
    await admin.from("prd_jobs").update({ total_steps: totalSteps }).eq("id", job.id);
  }

  if (idx >= totalSteps) {
    const sections = await loadPrdDraftSections(projectId);
    const prd = assemblePrd(project.name, params.discovery, sections);
    const finishedAt = new Date().toISOString();

    const { data: last } = await admin
      .from("prds")
      .select("version")
      .eq("project_id", projectId)
      .order("version", { ascending: false })
      .limit(1)
      .maybeSingle();

    await admin.from("prds").insert({
      project_id: projectId,
      version: (last?.version ?? 0) + 1,
      content_md: prd,
      created_by: job.created_by,
    });

    await clearPrdDraftSections(projectId);
    await admin
      .from("prd_jobs")
      .update({
        status: "done",
        step_started_at: null,
        current_step_label: null,
        updated_at: finishedAt,
      })
      .eq("id", job.id);

    return { status: "done", processed: totalSteps, total: totalSteps, prd };
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
    .from("prd_jobs")
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
  let sections = await loadPrdDraftSections(projectId);

  try {
    let content: string | null = null;
    let lastError: Error | null = null;
    const maxAttempts = step.id.startsWith("functional-") ? 3 : 2;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        const result = await generatePrdStep(params, step.id, sections);
        content = result.content;
        lastError = null;
        break;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        if (attempt < maxAttempts - 1) {
          await sleep(2000);
        }
      }
    }

    if (lastError || content == null) {
      throw lastError ?? new Error("Falha ao gerar seção do PRD.");
    }

    sections = { ...sections, [step.id]: content };
    await savePrdDraftSections(projectId, sections);

    const processed = idx + 1;
    const done = processed >= totalSteps;
    const nextStep = steps[processed];
    const finishedAt = new Date().toISOString();

    if (!done) {
      await admin
        .from("prd_jobs")
        .update({
          processed_steps: processed,
          current_step_label: nextStep?.label ?? null,
          step_started_at: null,
          updated_at: finishedAt,
        })
        .eq("id", job.id);

      return {
        status: "running",
        processed,
        total: totalSteps,
        currentStepLabel: nextStep?.label ?? null,
      };
    }

    const prd = assemblePrd(project.name, params.discovery, sections);

    const { data: last } = await admin
      .from("prds")
      .select("version")
      .eq("project_id", projectId)
      .order("version", { ascending: false })
      .limit(1)
      .maybeSingle();

    await admin.from("prds").insert({
      project_id: projectId,
      version: (last?.version ?? 0) + 1,
      content_md: prd,
      created_by: job.created_by,
    });

    await clearPrdDraftSections(projectId);
    await admin
      .from("prd_jobs")
      .update({
        status: "done",
        processed_steps: processed,
        current_step_label: null,
        step_started_at: null,
        updated_at: finishedAt,
      })
      .eq("id", job.id);

    return { status: "done", processed, total: totalSteps, prd };
  } catch (error) {
    const message =
      error instanceof AnthropicError
        ? error.message
        : error instanceof Error
          ? error.message
          : "Erro ao gerar o PRD.";

    await admin
      .from("prd_jobs")
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
