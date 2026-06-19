import { resolveActors } from "./actors";
import { AnthropicError } from "./anthropic-client";
import {
  chunkDiscovery,
  compareDiscoveryPrototype,
  critiqueDiscoveryChunk,
} from "./analysis-service";
import { type GapRow, gapToRow, mapGapRow } from "./project-access";
import { getSupabaseAdmin } from "./supabase";
import { Gap } from "./types";

// Janela em que consideramos um passo "em voo": se outro worker reivindicou o
// passo há menos disso, evitamos processar em duplicidade.
const STEP_LOCK_MS = 90_000;

export interface AnalysisStepResult {
  status: "running" | "done" | "error";
  processed: number;
  total: number;
  gaps?: Gap[];
  error?: string;
  /** true quando outro worker já está processando este passo (não houve avanço). */
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

async function getLatestAnalysis(projectId: string) {
  const admin = getSupabaseAdmin();
  const { data } = await admin
    .from("analyses")
    .select("*")
    .eq("project_id", projectId)
    .order("round", { ascending: false })
    .limit(1)
    .maybeSingle();
  return data;
}

export async function readGaps(analysisId: string): Promise<Gap[]> {
  const admin = getSupabaseAdmin();
  const { data } = await admin
    .from("gaps")
    .select("*")
    .eq("analysis_id", analysisId);
  const rows = (data ?? []) as GapRow[];
  const actors = await resolveActors(
    rows.flatMap((row) => [
      row.resolved_by,
      row.resposta_by,
      row.figma_reminder_sent_by,
    ])
  );
  return rows.map((row) => mapGapRow(row, actors));
}

async function finishJob(jobId: string, analysisId: string): Promise<void> {
  const admin = getSupabaseAdmin();
  await admin
    .from("analysis_jobs")
    .update({ status: "done", step_started_at: null, updated_at: new Date().toISOString() })
    .eq("id", jobId);
  await admin.from("analyses").update({ status: "done" }).eq("id", analysisId);
}

/**
 * Processa exatamente UM bloco da análise corrente do projeto. É a unidade de
 * trabalho compartilhada pela rota interna (worker) e pela rota autenticada
 * `/analyze/step`. Usa compare-and-set em `processed_chunks` + `step_started_at`
 * para que dois workers simultâneos (chain + pg_cron) não processem o mesmo passo.
 */
export async function runAnalysisStep(
  projectId: string,
  options: { force?: boolean } = {}
): Promise<AnalysisStepResult> {
  const admin = getSupabaseAdmin();
  const analysis = await getLatestAnalysis(projectId);

  if (!analysis) {
    return { status: "error", processed: 0, total: 0, error: "Nenhuma análise iniciada." };
  }

  const { data: job } = await admin
    .from("analysis_jobs")
    .select("*")
    .eq("analysis_id", analysis.id)
    .maybeSingle();

  if (!job) {
    return { status: "error", processed: 0, total: 0, error: "Job de análise não encontrado." };
  }

  if (job.status === "done") {
    const gaps = await readGaps(analysis.id);
    return { status: "done", processed: job.total_chunks, total: job.total_chunks, gaps };
  }

  if (job.status === "error") {
    return {
      status: "error",
      processed: job.processed_chunks,
      total: job.total_chunks,
      error: job.error ?? "Erro na análise.",
    };
  }

  let discovery: string = analysis.discovery_snapshot ?? "";
  let prototype: string | null = analysis.prototype_snapshot ?? null;
  if (!discovery) {
    const current = await getSourceTexts(projectId);
    discovery = current.discovery;
    prototype = current.prototype;
  }

  const chunks = chunkDiscovery(discovery);
  const hasPrototype = Boolean(prototype && prototype.trim());
  const totalSteps = chunks.length + (hasPrototype ? 1 : 0);
  const idx = job.processed_chunks;

  if (job.total_chunks !== totalSteps) {
    await admin
      .from("analysis_jobs")
      .update({ total_chunks: totalSteps })
      .eq("id", job.id);
  }

  if (idx >= totalSteps) {
    await finishJob(job.id, analysis.id);
    const gaps = await readGaps(analysis.id);
    return { status: "done", processed: totalSteps, total: totalSteps, gaps };
  }

  // Se outro worker reivindicou este passo recentemente, não duplica o trabalho.
  const stepStartedAt = job.step_started_at as string | null | undefined;
  if (!options.force && stepStartedAt) {
    const elapsed = Date.now() - new Date(stepStartedAt).getTime();
    if (elapsed < STEP_LOCK_MS) {
      return { status: "running", processed: idx, total: totalSteps, skipped: true };
    }
  }

  // Reivindica o passo: só vence quem conseguir setar step_started_at enquanto
  // o job ainda está running e em processed_chunks === idx.
  const now = new Date().toISOString();
  const { data: claimed } = await admin
    .from("analysis_jobs")
    .update({ step_started_at: now, updated_at: now })
    .eq("id", job.id)
    .eq("status", "running")
    .eq("processed_chunks", idx)
    .select("id")
    .maybeSingle();

  if (!claimed && !options.force) {
    return { status: "running", processed: idx, total: totalSteps, skipped: true };
  }

  const payload = (job.payload ?? {}) as {
    previous_gaps?: Gap[];
    respostas?: Record<string, string>;
  };
  const respostas = payload.respostas ?? {};
  const isCompareStep = hasPrototype && idx === chunks.length;

  try {
    let gaps: Gap[];
    if (isCompareStep) {
      const prevCompare = (payload.previous_gaps ?? []).filter(
        (g) => g.source === "comparacao"
      );
      gaps = await compareDiscoveryPrototype({
        discovery,
        prototype: prototype as string,
        previousGaps: prevCompare,
        respostas,
      });
    } else {
      const prevDiscovery = (payload.previous_gaps ?? []).filter(
        (g) => g.source !== "comparacao"
      );
      gaps = await critiqueDiscoveryChunk({
        discoveryChunk: chunks[idx],
        previousGaps: prevDiscovery,
        respostas,
      });
    }

    if (gaps.length > 0) {
      const rows = gaps.map((gap) => {
        const row = gapToRow(gap, projectId, analysis.id) as Record<string, unknown>;
        if (respostas[gap.id]?.trim()) {
          row.resposta = respostas[gap.id].trim();
        }
        return row;
      });
      await admin.from("gaps").upsert(rows, { onConflict: "analysis_id,gap_hash" });
    }

    const processed = idx + 1;
    const done = processed >= totalSteps;
    const finishedAt = new Date().toISOString();

    await admin
      .from("analysis_jobs")
      .update({
        processed_chunks: processed,
        status: done ? "done" : "running",
        step_started_at: null,
        updated_at: finishedAt,
      })
      .eq("id", job.id);

    if (done) {
      await admin.from("analyses").update({ status: "done" }).eq("id", analysis.id);
      const allGaps = await readGaps(analysis.id);
      return { status: "done", processed, total: totalSteps, gaps: allGaps };
    }

    return { status: "running", processed, total: totalSteps };
  } catch (error) {
    const message =
      error instanceof AnthropicError
        ? error.message
        : error instanceof Error
          ? error.message
          : "Erro ao processar a análise.";

    await admin
      .from("analysis_jobs")
      .update({ status: "error", error: message, step_started_at: null, updated_at: new Date().toISOString() })
      .eq("id", job.id);
    await admin.from("analyses").update({ status: "error" }).eq("id", analysis.id);

    return { status: "error", processed: idx, total: totalSteps, error: message };
  }
}
