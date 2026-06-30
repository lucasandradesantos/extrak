import { Router } from "express";
import { pickActor, resolveActors } from "../actors";
import { AnthropicError } from "../anthropic-client";
import { readGaps, runAnalysisStep } from "../analysis-runner";
import {
  scheduleAnalysisWorker,
  schedulePrdWorker,
  scheduleScopeWorker,
} from "../analysis-worker-client";
import type { AuthedRequest } from "../auth";
import {
  assembleDesignSystem,
  generateDesignSystemStep,
  planDesignSystemSteps,
  type DesignSystemGenParams,
} from "../design-system-service";
import {
  chunkDiscovery,
  generateSpecDoc,
} from "../analysis-service";
import {
  assemblePrd,
  clearPrdDraftSections,
  completedPrdStepIds,
  generatePrdStep,
  loadPrdDraftSections,
  planPrdSteps,
  savePrdDraftSections,
  type PrdGenParams,
} from "../prd-service";
import {
  assembleQaTestCasesDoc,
  generateQaTestCasesStep,
  planQaTestCasesSteps,
  validateQaTestCasesDoc,
  type QaGenParams,
} from "../qa-service";
import {
  clearScopeDraft,
  getScopeConfig,
  loadScope,
  planScopeSteps,
  saveScope,
  type ScopeData,
} from "../scope-service";
import {
  SPEC_DOCS,
  type SpecDocGroup,
  type SpecDocKind,
  docOrderForGroup,
} from "../spec-docs";
import { refreshProjectSources } from "../figma-service";
import { fileKeyForGapSource, postGapReminder } from "../figma-comments";
import { diffGaps } from "../gaps";
import {
  type GapRow,
  loadProjectForUser,
  mapGapRow,
} from "../project-access";
import { getSupabaseAdmin } from "../supabase";
import { FigmaApiError, Gap } from "../types";
import { runWithUsageContext } from "../usage-context";

export const analysisRouter = Router();

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

// Textos + metadata das fontes atuais (usado para montar o snapshot da rodada).
async function getSourcesFull(projectId: string) {
  const admin = getSupabaseAdmin();
  const { data } = await admin
    .from("project_sources")
    .select("kind, discovery_text, metadata")
    .eq("project_id", projectId);

  const discoveryRow = data?.find((s) => s.kind === "discovery");
  const prototypeRow = data?.find((s) => s.kind === "prototype");
  return {
    discovery: discoveryRow?.discovery_text ?? "",
    prototype: prototypeRow?.discovery_text ?? null,
    discoveryMetadata: discoveryRow?.metadata ?? null,
    prototypeMetadata: prototypeRow?.metadata ?? null,
  };
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

// Inicia uma análise (cria analysis + job). Use { reprocess: true } para refinar.
analysisRouter.post("/:id/analyze", async (req: AuthedRequest, res) => {
  const project = await loadProjectForUser(req, req.params.id);
  if (!project) {
    res.status(404).json({ error: "Projeto não encontrado." });
    return;
  }

  const { reprocess } = req.body as { reprocess?: boolean };
  const admin = getSupabaseAdmin();

  // Se já há job em andamento, retoma em vez de criar outro (não re-extrai).
  if (!reprocess) {
    const { data: runningJob } = await admin
      .from("analysis_jobs")
      .select("*")
      .eq("project_id", project.id)
      .eq("status", "running")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (runningJob) {
      // Garante que o worker está rodando (retoma um chain que pode ter morrido).
      scheduleAnalysisWorker(project.id);
      res.status(200).json({
        analysisId: runningJob.analysis_id,
        jobId: runningJob.id,
        total: runningJob.total_chunks,
        processed: runningJob.processed_chunks,
        status: "running",
        resumed: true,
      });
      return;
    }
  }

  // Discovery/Protótipo + metadata para o snapshot desta rodada.
  let discovery: string;
  let prototype: string | null;
  let discoveryMetadata: unknown;
  let prototypeMetadata: unknown;

  try {
    // Sempre re-extrai Discovery/Protótipo do Figma antes de analisar.
    const refreshed = await refreshProjectSources(project as any);
    discovery = refreshed.discovery.text;
    prototype = refreshed.prototype?.text ?? null;
    discoveryMetadata = refreshed.discovery.metadata;
    prototypeMetadata = refreshed.prototype?.metadata ?? null;
  } catch (error) {
    if (error instanceof FigmaApiError) {
      const status =
        error.statusCode === 403 ? 403 : error.statusCode === 404 ? 404 : 502;
      res.status(status).json({ error: error.message });
      return;
    }
    console.error("Erro ao re-extrair fontes do Figma:", error);
    res
      .status(500)
      .json({ error: error instanceof Error ? error.message : "Erro ao extrair do Figma." });
    return;
  }

  if (!discovery.trim()) {
    res.status(400).json({ error: "O Discovery deste projeto está vazio." });
    return;
  }

  const chunks = chunkDiscovery(discovery);
  const hasPrototype = Boolean(prototype && prototype.trim());
  // 1 passo extra de comparação Discovery×Protótipo (Discovery inteiro, 1 chamada).
  const totalSteps = chunks.length + (hasPrototype ? 1 : 0);
  const previous = await getLatestAnalysis(project.id);

  // Reavaliação: carrega comentários e resoluções da rodada anterior.
  let previousGaps: Gap[] = [];
  let respostas: Record<string, string> = {};
  if (reprocess && previous) {
    const { data: rows } = await admin
      .from("gaps")
      .select("*")
      .eq("analysis_id", previous.id);
    for (const row of (rows ?? []) as GapRow[]) {
      const gap = mapGapRow(row);
      const hasComment = Boolean(gap.resposta?.trim());
      const isResolved = gap.status === "resolvido";
      if (hasComment || isResolved) {
        previousGaps.push(gap);
        if (hasComment) respostas[gap.id] = gap.resposta!.trim();
      }
    }
  }

  const sourceMetadata = {
    discovery: discoveryMetadata,
    prototype: prototypeMetadata,
  };

  const { data: analysis, error: analysisError } = await admin
    .from("analyses")
    .insert({
      project_id: project.id,
      round: (previous?.round ?? 0) + 1,
      status: "running",
      discovery_snapshot: discovery,
      prototype_snapshot: prototype,
      source_metadata: sourceMetadata,
      created_by: req.authUser?.id ?? null,
    })
    .select("*")
    .single();

  if (analysisError || !analysis) {
    res.status(500).json({ error: "Erro ao criar a análise." });
    return;
  }

  const { data: job, error: jobError } = await admin
    .from("analysis_jobs")
    .insert({
      project_id: project.id,
      analysis_id: analysis.id,
      status: "running",
      total_chunks: totalSteps,
      processed_chunks: 0,
      payload: { reprocess: Boolean(reprocess), previous_gaps: previousGaps, respostas },
    })
    .select("*")
    .single();

  if (jobError || !job) {
    res.status(500).json({ error: "Erro ao criar o job de análise." });
    return;
  }

  // Dispara o worker no backend: a análise avança bloco a bloco mesmo que o
  // usuário feche a aba do navegador.
  scheduleAnalysisWorker(project.id);

  res.status(201).json({
    analysisId: analysis.id,
    jobId: job.id,
    total: totalSteps,
    processed: 0,
    status: "running",
  });
});

// Processa o próximo chunk da análise corrente. Mantida por compatibilidade e
// para depuração; o fluxo normal usa o worker no backend (Edge Function/cron).
// Reagenda o worker para garantir que o restante da análise continue.
analysisRouter.post("/:id/analyze/step", async (req: AuthedRequest, res) => {
  const project = await loadProjectForUser(req, req.params.id);
  if (!project) {
    res.status(404).json({ error: "Projeto não encontrado." });
    return;
  }

  const result = await runAnalysisStep(project.id, { force: true });

  if (result.status === "error") {
    if (result.error && /cr[ée]dit|api anthropic|rate limit/i.test(result.error)) {
      res.status(502).json({ error: result.error });
      return;
    }
    res.status(500).json({ error: result.error ?? "Erro ao processar a análise." });
    return;
  }

  if (result.status === "running") {
    scheduleAnalysisWorker(project.id);
  }

  res.json({
    status: result.status,
    processed: result.processed,
    total: result.total,
    gaps: result.gaps,
  });
});

// Lista as rodadas de análise do projeto (timeline do histórico).
analysisRouter.get("/:id/analyses", async (req: AuthedRequest, res) => {
  const project = await loadProjectForUser(req, req.params.id);
  if (!project) {
    res.status(404).json({ error: "Projeto não encontrado." });
    return;
  }

  const admin = getSupabaseAdmin();
  const { data: rounds } = await admin
    .from("analyses")
    .select("id, round, status, created_at, source_metadata, created_by")
    .eq("project_id", project.id)
    .order("round", { ascending: false });

  const roundActors = await resolveActors((rounds ?? []).map((round) => round.created_by));

  const items = await Promise.all(
    (rounds ?? []).map(async (round) => {
      const gaps = await readGaps(round.id);
      const counts = { alta: 0, media: 0, baixa: 0 };
      for (const gap of gaps) {
        if (gap.status !== "resolvido") counts[gap.severidade] += 1;
      }
      return {
        id: round.id,
        round: round.round,
        status: round.status,
        created_at: round.created_at,
        source_metadata: round.source_metadata ?? null,
        created_by: pickActor(roundActors, round.created_by),
        total: counts.alta + counts.media + counts.baixa,
        counts,
      };
    })
  );

  res.json({ analyses: items });
});

// Compara duas rodadas: resolvidos, novos e persistentes (gaps enriquecidos).
analysisRouter.get("/:id/analyses/compare", async (req: AuthedRequest, res) => {
  const project = await loadProjectForUser(req, req.params.id);
  if (!project) {
    res.status(404).json({ error: "Projeto não encontrado." });
    return;
  }

  const from = typeof req.query.from === "string" ? req.query.from : "";
  const to = typeof req.query.to === "string" ? req.query.to : "";
  if (!from || !to) {
    res.status(400).json({ error: "Informe as rodadas 'from' e 'to'." });
    return;
  }

  const admin = getSupabaseAdmin();
  const { data: rounds } = await admin
    .from("analyses")
    .select("id, round, project_id, created_at, source_metadata, created_by")
    .in("id", [from, to]);

  const fromRound = rounds?.find((r) => r.id === from);
  const toRound = rounds?.find((r) => r.id === to);
  if (
    !fromRound ||
    !toRound ||
    fromRound.project_id !== project.id ||
    toRound.project_id !== project.id
  ) {
    res.status(404).json({ error: "Rodada(s) não encontrada(s) neste projeto." });
    return;
  }

  const compareActors = await resolveActors([fromRound.created_by, toRound.created_by]);

  const [gapsFrom, gapsTo] = await Promise.all([
    readGaps(from),
    readGaps(to),
  ]);

  const diff = diffGaps(gapsFrom, gapsTo);
  const byId = new Map<string, Gap>();
  for (const gap of [...gapsFrom, ...gapsTo]) byId.set(gap.id, gap);
  const pick = (ids: string[]) =>
    ids.map((id) => byId.get(id)).filter((g): g is Gap => Boolean(g));

  res.json({
    from: {
      id: fromRound.id,
      round: fromRound.round,
      created_at: fromRound.created_at,
      source_metadata: fromRound.source_metadata ?? null,
      created_by: pickActor(compareActors, fromRound.created_by),
    },
    to: {
      id: toRound.id,
      round: toRound.round,
      created_at: toRound.created_at,
      source_metadata: toRound.source_metadata ?? null,
      created_by: pickActor(compareActors, toRound.created_by),
    },
    resolved: pick(diff.resolvidos),
    new: pick(diff.novos),
    persistent: pick(diff.abertos),
  });
});

// Detalhe de uma rodada: gaps + metadata (texto do snapshot via ?includeText=1).
analysisRouter.get("/:id/analyses/:analysisId", async (req: AuthedRequest, res) => {
  const project = await loadProjectForUser(req, req.params.id);
  if (!project) {
    res.status(404).json({ error: "Projeto não encontrado." });
    return;
  }

  const includeText = req.query.includeText === "1";
  const admin = getSupabaseAdmin();
  const { data: round } = await admin
    .from("analyses")
    .select("*")
    .eq("id", req.params.analysisId)
    .eq("project_id", project.id)
    .maybeSingle();

  if (!round) {
    res.status(404).json({ error: "Rodada não encontrada." });
    return;
  }

  const gaps = await readGaps(round.id);
  const roundActors = await resolveActors([round.created_by]);
  res.json({
    id: round.id,
    round: round.round,
    status: round.status,
    created_at: round.created_at,
    source_metadata: round.source_metadata ?? null,
    created_by: pickActor(roundActors, round.created_by),
    gaps,
    ...(includeText
      ? {
          discovery_snapshot: round.discovery_snapshot ?? null,
          prototype_snapshot: round.prototype_snapshot ?? null,
        }
      : {}),
  });
});

// Salva respostas e/ou status dos gaps da análise corrente.
analysisRouter.patch("/:id/gaps", async (req: AuthedRequest, res) => {
  const project = await loadProjectForUser(req, req.params.id);
  if (!project) {
    res.status(404).json({ error: "Projeto não encontrado." });
    return;
  }

  const { responses, statuses } = req.body as {
    responses?: Record<string, string>;
    statuses?: Record<string, "aberto" | "resolvido">;
  };

  const admin = getSupabaseAdmin();
  const analysis = await getLatestAnalysis(project.id);
  if (!analysis) {
    res.status(400).json({ error: "Nenhuma análise para atualizar." });
    return;
  }

  const ids = new Set<string>([
    ...Object.keys(responses ?? {}),
    ...Object.keys(statuses ?? {}),
  ]);

  const userId = req.authUser?.id;
  const now = new Date().toISOString();

  for (const gapId of ids) {
    const update: Record<string, unknown> = {};
    if (responses && gapId in responses) {
      update.resposta = responses[gapId];
      if (userId) {
        update.resposta_by = userId;
        update.resposta_at = now;
      }
    }
    if (statuses && gapId in statuses) {
      update.status = statuses[gapId];
      if (statuses[gapId] === "resolvido") {
        if (userId) {
          update.resolved_by = userId;
          update.resolved_at = now;
        }
      } else if (statuses[gapId] === "aberto") {
        update.resolved_by = null;
        update.resolved_at = null;
      }
    }
    if (Object.keys(update).length === 0) continue;
    await admin
      .from("gaps")
      .update(update)
      .eq("analysis_id", analysis.id)
      .eq("gap_hash", gapId);
  }

  const gaps = await readGaps(analysis.id);
  res.json({ gaps });
});

// Publica um lembrete do gap como comentário no Figma/FigJam correspondente.
analysisRouter.post("/:id/gaps/:gapId/figma-reminder", async (req: AuthedRequest, res) => {
  const project = await loadProjectForUser(req, req.params.id);
  if (!project) {
    res.status(404).json({ error: "Projeto não encontrado." });
    return;
  }

  const admin = getSupabaseAdmin();
  const analysis = await getLatestAnalysis(project.id);
  if (!analysis) {
    res.status(400).json({ error: "Nenhuma análise encontrada." });
    return;
  }

  const gaps = await readGaps(analysis.id);
  const gap = gaps.find((g) => g.id === req.params.gapId);
  if (!gap) {
    res.status(404).json({ error: "Gap não encontrado." });
    return;
  }

  if (gap.figma_reminder_sent_at) {
    res.status(409).json({
      error: "Um lembrete já foi enviado para este gap.",
      sentAt: gap.figma_reminder_sent_at,
      nodeName: gap.figma_reminder_node_name,
    });
    return;
  }

  const fileKey = fileKeyForGapSource(
    gap.source,
    project.discovery_file_key ?? null,
    project.prototype_file_key ?? null
  );
  if (!fileKey) {
    res.status(400).json({ error: "Este projeto não tem arquivo Figma associado." });
    return;
  }

  try {
    const result = await postGapReminder({
      fileKey,
      gap,
      projectName: project.name,
    });

    const sentAt = new Date().toISOString();
    const { error: updateError } = await admin
      .from("gaps")
      .update({
        figma_reminder_sent_at: sentAt,
        figma_reminder_node_name: result.nodeName,
        figma_reminder_sent_by: req.authUser?.id ?? null,
      })
      .eq("analysis_id", analysis.id)
      .eq("gap_hash", gap.id);

    if (updateError) {
      console.error("Erro ao salvar lembrete no gap:", updateError);
      res.status(500).json({ error: "Lembrete enviado ao Figma, mas falhou ao registrar no sistema." });
      return;
    }

    res.json({ ...result, sentAt, gapId: gap.id });
  } catch (error) {
    if (error instanceof FigmaApiError) {
      const status =
        error.statusCode === 403 ? 403 : error.statusCode === 404 ? 404 : 502;
      res.status(status).json({ error: error.message });
      return;
    }
    console.error("Erro ao enviar lembrete no Figma:", error);
    res.status(500).json({
      error: error instanceof Error ? error.message : "Erro ao enviar lembrete.",
    });
  }
});

// Inicia geração de PRD no backend (worker). O frontend só acompanha o progresso.
analysisRouter.post("/:id/prd/start", async (req: AuthedRequest, res) => {
  const project = await loadProjectForUser(req, req.params.id);
  if (!project) {
    res.status(404).json({ error: "Projeto não encontrado." });
    return;
  }

  const admin = getSupabaseAdmin();
  const { discovery } = await getSourceTexts(project.id);

  if (!discovery.trim()) {
    res.status(400).json({ error: "O Discovery deste projeto está vazio." });
    return;
  }

  const { data: runningJob } = await admin
    .from("prd_jobs")
    .select("*")
    .eq("project_id", project.id)
    .eq("status", "running")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (runningJob) {
    schedulePrdWorker(project.id);
    res.status(200).json({
      jobId: runningJob.id,
      status: "running",
      total: runningJob.total_steps,
      processed: runningJob.processed_steps,
      currentStepLabel: runningJob.current_step_label,
      resumed: true,
    });
    return;
  }

  const steps = planPrdSteps(discovery);
  const draft = await loadPrdDraftSections(project.id);
  const completedIds = completedPrdStepIds(discovery, draft);
  const hasPartialDraft =
    completedIds.length > 0 && completedIds.length < steps.length;

  const { data: latestPrd } = await admin
    .from("prds")
    .select("id")
    .eq("project_id", project.id)
    .order("version", { ascending: false })
    .limit(1)
    .maybeSingle();

  const reset = Boolean(latestPrd) && !hasPartialDraft;
  if (reset) {
    await clearPrdDraftSections(project.id);
  }

  const initialProcessed = reset ? 0 : completedIds.length;
  const currentStep = steps[initialProcessed];

  const { data: job, error: jobError } = await admin
    .from("prd_jobs")
    .insert({
      project_id: project.id,
      status: "running",
      total_steps: steps.length,
      processed_steps: initialProcessed,
      current_step_label: currentStep?.label ?? null,
      created_by: req.authUser?.id ?? null,
    })
    .select("*")
    .single();

  if (jobError || !job) {
    res.status(500).json({ error: "Erro ao iniciar a geração do PRD." });
    return;
  }

  schedulePrdWorker(project.id);

  res.status(201).json({
    jobId: job.id,
    status: "running",
    total: steps.length,
    processed: initialProcessed,
    currentStepLabel: currentStep?.label ?? null,
  });
});

analysisRouter.get("/:id/prd/status", async (req: AuthedRequest, res) => {
  const project = await loadProjectForUser(req, req.params.id);
  if (!project) {
    res.status(404).json({ error: "Projeto não encontrado." });
    return;
  }

  const admin = getSupabaseAdmin();
  const { data: job } = await admin
    .from("prd_jobs")
    .select("*")
    .eq("project_id", project.id)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!job) {
    res.json({ status: "idle" as const });
    return;
  }

  let prd: string | null = null;
  if (job.status === "done") {
    const { data: latestPrd } = await admin
      .from("prds")
      .select("content_md")
      .eq("project_id", project.id)
      .order("version", { ascending: false })
      .limit(1)
      .maybeSingle();
    prd = latestPrd?.content_md ?? null;
  }

  res.json({
    jobId: job.id,
    status: job.status,
    total: job.total_steps,
    processed: job.processed_steps,
    currentStepLabel: job.current_step_label,
    error: job.error,
    prd,
  });
});

// --- Escopo (calculadora de horas) ------------------------------------------

// Inicia geração de escopo no backend (worker). O frontend só acompanha.
analysisRouter.post("/:id/scope/start", async (req: AuthedRequest, res) => {
  const project = await loadProjectForUser(req, req.params.id);
  if (!project) {
    res.status(404).json({ error: "Projeto não encontrado." });
    return;
  }

  const admin = getSupabaseAdmin();
  const { discovery } = await getSourceTexts(project.id);

  if (!discovery.trim()) {
    res.status(400).json({ error: "O Discovery deste projeto está vazio." });
    return;
  }

  const { data: runningJob } = await admin
    .from("scope_jobs")
    .select("*")
    .eq("project_id", project.id)
    .eq("status", "running")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (runningJob) {
    scheduleScopeWorker(project.id);
    res.status(200).json({
      jobId: runningJob.id,
      status: "running",
      total: runningJob.total_steps,
      processed: runningJob.processed_steps,
      currentStepLabel: runningJob.current_step_label,
      resumed: true,
    });
    return;
  }

  const body = (req.body ?? {}) as {
    sales_model?: string;
    risk_margin?: number;
  };
  const salesModel = body.sales_model === "banco_horas" ? "banco_horas" : "fechado";
  const riskMargin = Math.min(1, Math.max(0, Number(body.risk_margin) || 0));

  // Geração nova começa limpa: descarta rascunho de uma tentativa anterior para
  // não reprocessar/duplicar módulos (e não pagar de novo pelos chunks já feitos).
  await clearScopeDraft(project.id);

  const steps = planScopeSteps(discovery);
  const currentStep = steps[0];

  const { data: job, error: jobError } = await admin
    .from("scope_jobs")
    .insert({
      project_id: project.id,
      status: "running",
      total_steps: steps.length,
      processed_steps: 0,
      current_step_label: currentStep?.label ?? null,
      payload: { sales_model: salesModel, risk_margin: riskMargin },
      created_by: req.authUser?.id ?? null,
    })
    .select("*")
    .single();

  if (jobError || !job) {
    res.status(500).json({ error: "Erro ao iniciar a geração do escopo." });
    return;
  }

  scheduleScopeWorker(project.id);

  res.status(201).json({
    jobId: job.id,
    status: "running",
    total: steps.length,
    processed: 0,
    currentStepLabel: currentStep?.label ?? null,
  });
});

analysisRouter.get("/:id/scope/status", async (req: AuthedRequest, res) => {
  const project = await loadProjectForUser(req, req.params.id);
  if (!project) {
    res.status(404).json({ error: "Projeto não encontrado." });
    return;
  }

  const admin = getSupabaseAdmin();
  const { data: job } = await admin
    .from("scope_jobs")
    .select("*")
    .eq("project_id", project.id)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!job) {
    res.json({ status: "idle" as const });
    return;
  }

  let scope: ScopeData | null = null;
  if (job.status === "done") {
    scope = await loadScope(project.id);
  }

  res.json({
    jobId: job.id,
    status: job.status,
    total: job.total_steps,
    processed: job.processed_steps,
    currentStepLabel: job.current_step_label,
    error: job.error,
    scope,
  });
});

// Escopo atual (editável) + configuração global de cálculo.
analysisRouter.get("/:id/scope", async (req: AuthedRequest, res) => {
  const project = await loadProjectForUser(req, req.params.id);
  if (!project) {
    res.status(404).json({ error: "Projeto não encontrado." });
    return;
  }

  const [scope, config] = await Promise.all([
    loadScope(project.id),
    getScopeConfig(),
  ]);

  res.json({ scope, config });
});

// Salva edições manuais do escopo (auto-save debounced do frontend).
analysisRouter.patch("/:id/scope", async (req: AuthedRequest, res) => {
  const project = await loadProjectForUser(req, req.params.id);
  if (!project) {
    res.status(404).json({ error: "Projeto não encontrado." });
    return;
  }

  const body = req.body as { scope?: ScopeData };
  if (!body?.scope || !Array.isArray(body.scope.modules)) {
    res.status(400).json({ error: "Escopo inválido." });
    return;
  }

  await saveScope(project.id, body.scope);
  res.json({ ok: true });
});

// Consumo de tokens/créditos do projeto, agregado por feature.
analysisRouter.get("/:id/usage", async (req: AuthedRequest, res) => {
  const project = await loadProjectForUser(req, req.params.id);
  if (!project) {
    res.status(404).json({ error: "Projeto não encontrado." });
    return;
  }

  const admin = getSupabaseAdmin();
  const { data } = await admin
    .from("token_usage")
    .select("feature, input_tokens, output_tokens, cost_usd")
    .eq("project_id", project.id);

  const byFeature = new Map<
    string,
    { feature: string; input_tokens: number; output_tokens: number; cost_usd: number; calls: number }
  >();
  const totals = { input_tokens: 0, output_tokens: 0, cost_usd: 0, calls: 0 };

  for (const row of data ?? []) {
    const input = row.input_tokens ?? 0;
    const output = row.output_tokens ?? 0;
    const cost = Number(row.cost_usd ?? 0);
    totals.input_tokens += input;
    totals.output_tokens += output;
    totals.cost_usd += cost;
    totals.calls += 1;

    const key = row.feature ?? "outros";
    const agg =
      byFeature.get(key) ??
      { feature: key, input_tokens: 0, output_tokens: 0, cost_usd: 0, calls: 0 };
    agg.input_tokens += input;
    agg.output_tokens += output;
    agg.cost_usd += cost;
    agg.calls += 1;
    byFeature.set(key, agg);
  }

  totals.cost_usd = Number(totals.cost_usd.toFixed(4));
  const features = Array.from(byFeature.values())
    .map((f) => ({ ...f, cost_usd: Number(f.cost_usd.toFixed(4)) }))
    .sort((a, b) => b.cost_usd - a.cost_usd);

  res.json({ totals, byFeature: features });
});

// Gera (e persiste) o PRD em múltiplos passos.
analysisRouter.get("/:id/prd/plan", async (req: AuthedRequest, res) => {
  const project = await loadProjectForUser(req, req.params.id);
  if (!project) {
    res.status(404).json({ error: "Projeto não encontrado." });
    return;
  }

  const { discovery } = await getSourceTexts(project.id);
  if (!discovery.trim()) {
    res.status(400).json({ error: "O Discovery deste projeto está vazio." });
    return;
  }

  const steps = planPrdSteps(discovery);
  const draft = await loadPrdDraftSections(project.id);
  const completedStepIds = completedPrdStepIds(discovery, draft);

  res.json({
    steps: steps.map((s) => ({
      id: s.id,
      label: s.label,
      deterministic: Boolean(s.deterministic),
    })),
    total: steps.length,
    completedStepIds,
  });
});

analysisRouter.delete("/:id/prd/draft", async (req: AuthedRequest, res) => {
  const project = await loadProjectForUser(req, req.params.id);
  if (!project) {
    res.status(404).json({ error: "Projeto não encontrado." });
    return;
  }
  await clearPrdDraftSections(project.id);
  res.json({ ok: true });
});

analysisRouter.post("/:id/prd/step", async (req: AuthedRequest, res) => {
  try {
    const project = await loadProjectForUser(req, req.params.id);
    if (!project) {
      res.status(404).json({ error: "Projeto não encontrado." });
      return;
    }

    const { stepId, reset } = req.body as {
      stepId?: string;
      reset?: boolean;
    };

    if (!stepId || typeof stepId !== "string") {
      res.status(400).json({ error: "Informe o stepId do passo do PRD." });
      return;
    }

    const admin = getSupabaseAdmin();
    const analysis = await getLatestAnalysis(project.id);
    const gaps = analysis ? await readGaps(analysis.id) : [];
    const { discovery, prototype } = await getSourceTexts(project.id);

    if (!discovery.trim()) {
      res.status(400).json({ error: "O Discovery deste projeto está vazio." });
      return;
    }

    const respostas: Record<string, string> = {};
    for (const gap of gaps) {
      if (gap.resposta?.trim()) respostas[gap.id] = gap.resposta.trim();
    }

    const params: PrdGenParams = {
      discovery,
      prototype,
      gaps,
      respostas,
      productName: project.name,
    };

    let sections = reset ? {} : await loadPrdDraftSections(project.id);
    if (reset) {
      await clearPrdDraftSections(project.id);
    }

    const result = await runWithUsageContext(
      { projectId: project.id, feature: "prd", userId: req.authUser?.id },
      () => generatePrdStep(params, stepId, sections)
    );

    sections = { ...sections, [stepId]: result.content };
    await savePrdDraftSections(project.id, sections);

    if (!result.done) {
      res.json(result);
      return;
    }

    const prd = assemblePrd(project.name, discovery, sections);

    const { data: last } = await admin
      .from("prds")
      .select("version")
      .eq("project_id", project.id)
      .order("version", { ascending: false })
      .limit(1)
      .maybeSingle();

    const { data: prdRow } = await admin
      .from("prds")
      .insert({
        project_id: project.id,
        version: (last?.version ?? 0) + 1,
        content_md: prd,
        created_by: req.authUser?.id,
      })
      .select("*")
      .single();

    await clearPrdDraftSections(project.id);
    res.json({ ...result, prd, prdRow });
  } catch (error) {
    if (error instanceof AnthropicError) {
      res.status(502).json({ error: error.message });
      return;
    }
    const message =
      error instanceof Error ? error.message : "Erro desconhecido ao gerar o PRD.";
    const isAbort =
      error instanceof Error &&
      (error.name === "AbortError" ||
        error.name === "APIUserAbortError" ||
        /aborted|socket hang up|ECONNRESET/i.test(message));
    console.error(`Erro ao gerar passo do PRD (${req.body?.stepId}):`, error);
    res.status(isAbort ? 502 : 500).json({
      error: isAbort
        ? "A geração desta seção foi interrompida (timeout). Tente novamente."
        : message || "Erro ao gerar o PRD.",
    });
  }
});

// Legado: dispara geração completa via plano + passos (cliente deve preferir /prd/start).
analysisRouter.post("/:id/prd", async (req: AuthedRequest, res) => {
  res.status(400).json({
    error:
      "Use a geração no backend: POST /prd/start e acompanhe com GET /prd/status.",
  });
});

// Lista a versão mais recente de cada documento de um grupo (spec | qa).
analysisRouter.get("/:id/docs", async (req: AuthedRequest, res) => {
  const project = await loadProjectForUser(req, req.params.id);
  if (!project) {
    res.status(404).json({ error: "Projeto não encontrado." });
    return;
  }

  const group: SpecDocGroup = req.query.group === "qa" ? "qa" : "spec";
  const admin = getSupabaseAdmin();
  const { data: rows } = await admin
    .from("project_docs")
    .select("kind, content_md, version, created_at, updated_at")
    .eq("project_id", project.id)
    .order("version", { ascending: false });

  type DocRow = {
    kind: string;
    content_md: string;
    version: number;
    created_at: string;
    updated_at: string;
  };
  const latestByKind = new Map<string, DocRow>();
  for (const row of (rows ?? []) as DocRow[]) {
    if (!latestByKind.has(row.kind)) latestByKind.set(row.kind, row);
  }

  const docs = docOrderForGroup(group).map((kind) => {
    const meta = SPEC_DOCS[kind];
    const existing = latestByKind.get(kind);
    const content_md = existing?.content_md ?? null;
    return {
      kind,
      label: meta.label,
      filename: meta.filename,
      content_md,
      version: existing?.version ?? 0,
      updated_at: existing?.updated_at ?? null,
      ...(kind === "qa_test_cases" && content_md
        ? { qa_validation: validateQaTestCasesDoc(content_md) }
        : {}),
    };
  });

  res.json({ docs });
});

async function loadDocGenContext(projectId: string, userId?: string) {
  const admin = getSupabaseAdmin();
  const { discovery, prototype } = await getSourceTexts(projectId);
  const analysis = await getLatestAnalysis(projectId);
  const gaps = analysis ? await readGaps(analysis.id) : [];
  const respostas: Record<string, string> = {};
  for (const gap of gaps) {
    if (gap.resposta?.trim()) respostas[gap.id] = gap.resposta.trim();
  }
  const { data: latestPrd } = await admin
    .from("prds")
    .select("content_md")
    .eq("project_id", projectId)
    .order("version", { ascending: false })
    .limit(1)
    .maybeSingle();

  return {
    admin,
    discovery,
    prototype,
    gaps,
    respostas,
    prd: latestPrd?.content_md ?? null,
    userId,
  };
}

async function persistProjectDoc(
  admin: ReturnType<typeof getSupabaseAdmin>,
  projectId: string,
  kind: SpecDocKind,
  content: string,
  userId?: string
) {
  const { data: last } = await admin
    .from("project_docs")
    .select("version")
    .eq("project_id", projectId)
    .eq("kind", kind)
    .order("version", { ascending: false })
    .limit(1)
    .maybeSingle();

  const { data: docRow, error: insertError } = await admin
    .from("project_docs")
    .insert({
      project_id: projectId,
      kind,
      content_md: content,
      version: (last?.version ?? 0) + 1,
      created_by: userId,
    })
    .select("kind, content_md, version, updated_at")
    .single();

  if (insertError) {
    throw insertError;
  }
  return docRow;
}

/** Re-extrai protótipo se ainda não contém tokens visuais (upgrade de extração). */
async function ensurePrototypeWithDesignTokens(
  project: { id: string; discovery_file_key: string | null; prototype_file_key: string | null }
): Promise<string | null> {
  const { prototype } = await getSourceTexts(project.id);
  if (prototype?.includes("EXTRAK_DESIGN_TOKENS_START")) {
    return prototype;
  }
  if (!project.prototype_file_key || !project.discovery_file_key) {
    return prototype;
  }
  await refreshProjectSources(project);
  const refreshed = await getSourceTexts(project.id);
  return refreshed.prototype;
}

analysisRouter.get("/:id/docs/qa_test_cases/plan", async (req: AuthedRequest, res) => {
  const project = await loadProjectForUser(req, req.params.id);
  if (!project) {
    res.status(404).json({ error: "Projeto não encontrado." });
    return;
  }

  const { discovery } = await getSourceTexts(project.id);
  const steps = planQaTestCasesSteps(discovery);
  res.json({
    steps: steps.map((s) => ({
      id: s.id,
      label: s.label,
      kind: s.kind,
    })),
    total: steps.length,
  });
});

analysisRouter.post("/:id/docs/qa_test_cases/step", async (req: AuthedRequest, res) => {
  const project = await loadProjectForUser(req, req.params.id);
  if (!project) {
    res.status(404).json({ error: "Projeto não encontrado." });
    return;
  }

  const { stepId, sections = {} } = req.body as {
    stepId?: string;
    sections?: Record<string, string>;
  };

  if (!stepId || typeof stepId !== "string") {
    res.status(400).json({ error: "Informe o stepId do passo de QA." });
    return;
  }

  try {
    const ctx = await loadDocGenContext(project.id, req.authUser?.id);
    if (!ctx.discovery.trim()) {
      res.status(400).json({ error: "O Discovery deste projeto está vazio." });
      return;
    }

    const params: QaGenParams = {
      discovery: ctx.discovery,
      prototype: ctx.prototype,
      gaps: ctx.gaps,
      respostas: ctx.respostas,
      prd: ctx.prd,
      productName: project.name,
    };

    const result = await runWithUsageContext(
      { projectId: project.id, feature: "qa", userId: req.authUser?.id },
      () => generateQaTestCasesStep(params, stepId, sections)
    );

    if (!result.done) {
      res.json(result);
      return;
    }

    const allSections = { ...sections, [stepId]: result.content };
    const steps = planQaTestCasesSteps(ctx.discovery);
    const content = assembleQaTestCasesDoc(project.name, allSections, steps);
    const validation = validateQaTestCasesDoc(content);

    const docRow = await persistProjectDoc(
      ctx.admin,
      project.id,
      "qa_test_cases",
      content,
      req.authUser?.id
    );

    res.json({
      ...result,
      content_md: content,
      qa_validation: validation,
      doc: {
        kind: "qa_test_cases" as const,
        label: SPEC_DOCS.qa_test_cases.label,
        filename: SPEC_DOCS.qa_test_cases.filename,
        content_md: content,
        version: docRow?.version ?? 1,
        updated_at: docRow?.updated_at ?? null,
        qa_validation: validation,
      },
    });
  } catch (error) {
    if (error instanceof AnthropicError) {
      res.status(502).json({ error: error.message });
      return;
    }
    console.error("Erro ao gerar passo de QA:", error);
    res.status(500).json({ error: "Erro ao gerar os casos de teste." });
  }
});

analysisRouter.get("/:id/docs/design_system/plan", async (req: AuthedRequest, res) => {
  const project = await loadProjectForUser(req, req.params.id);
  if (!project) {
    res.status(404).json({ error: "Projeto não encontrado." });
    return;
  }

  const steps = planDesignSystemSteps();
  res.json({
    steps: steps.map((s) => ({
      id: s.id,
      label: s.label,
      deterministic: Boolean(s.deterministic),
    })),
    total: steps.length,
  });
});

analysisRouter.post("/:id/docs/design_system/step", async (req: AuthedRequest, res) => {
  const project = await loadProjectForUser(req, req.params.id);
  if (!project) {
    res.status(404).json({ error: "Projeto não encontrado." });
    return;
  }

  const { stepId, sections = {} } = req.body as {
    stepId?: string;
    sections?: Record<string, string>;
  };

  if (!stepId || typeof stepId !== "string") {
    res.status(400).json({ error: "Informe o stepId do passo do Design System." });
    return;
  }

  try {
    const ctx = await loadDocGenContext(project.id, req.authUser?.id);
    if (!ctx.discovery.trim()) {
      res.status(400).json({ error: "O Discovery deste projeto está vazio." });
      return;
    }

    const prototype = await ensurePrototypeWithDesignTokens({
      id: project.id as string,
      discovery_file_key: (project.discovery_file_key as string | null) ?? null,
      prototype_file_key: (project.prototype_file_key as string | null) ?? null,
    });

    const params: DesignSystemGenParams = {
      discovery: ctx.discovery,
      prototype,
      gaps: ctx.gaps,
      respostas: ctx.respostas,
      prd: ctx.prd,
      productName: project.name,
    };

    const result = await runWithUsageContext(
      { projectId: project.id, feature: "spec", userId: req.authUser?.id },
      () => generateDesignSystemStep(params, stepId, sections)
    );

    if (!result.done) {
      res.json(result);
      return;
    }

    const allSections = { ...sections, [stepId]: result.content };
    const content = assembleDesignSystem(project.name, allSections);
    const docRow = await persistProjectDoc(
      ctx.admin,
      project.id,
      "design_system",
      content,
      req.authUser?.id
    );

    res.json({
      ...result,
      content_md: content,
      doc: {
        kind: "design_system" as const,
        label: SPEC_DOCS.design_system.label,
        filename: SPEC_DOCS.design_system.filename,
        content_md: content,
        version: docRow?.version ?? 1,
        updated_at: docRow?.updated_at ?? null,
      },
    });
  } catch (error) {
    if (error instanceof AnthropicError) {
      res.status(502).json({ error: error.message });
      return;
    }
    console.error("Erro ao gerar passo do Design System:", error);
    res.status(500).json({ error: "Erro ao gerar o Design System." });
  }
});

// Gera (e persiste) UM documento do Pacote de Specs.
analysisRouter.post("/:id/docs/:kind", async (req: AuthedRequest, res) => {
  const project = await loadProjectForUser(req, req.params.id);
  if (!project) {
    res.status(404).json({ error: "Projeto não encontrado." });
    return;
  }

  const kind = req.params.kind as SpecDocKind;
  if (!SPEC_DOCS[kind]) {
    res.status(400).json({ error: "Tipo de documento inválido." });
    return;
  }

  if (kind === "design_system") {
    res.status(400).json({
      error:
        "Use a geração em passos: GET /docs/design_system/plan e POST /docs/design_system/step.",
    });
    return;
  }

  if (kind === "qa_test_cases") {
    res.status(400).json({
      error:
        "Use a geração em passos: GET /docs/qa_test_cases/plan e POST /docs/qa_test_cases/step.",
    });
    return;
  }

  const admin = getSupabaseAdmin();
  const { discovery, prototype } = await getSourceTexts(project.id);
  if (!discovery.trim()) {
    res.status(400).json({ error: "O Discovery deste projeto está vazio." });
    return;
  }

  const analysis = await getLatestAnalysis(project.id);
  const gaps = analysis ? await readGaps(analysis.id) : [];
  const respostas: Record<string, string> = {};
  for (const gap of gaps) {
    if (gap.resposta?.trim()) respostas[gap.id] = gap.resposta.trim();
  }

  const { data: latestPrd } = await admin
    .from("prds")
    .select("content_md")
    .eq("project_id", project.id)
    .order("version", { ascending: false })
    .limit(1)
    .maybeSingle();

  try {
    const content = await runWithUsageContext(
      { projectId: project.id, feature: "spec", userId: req.authUser?.id },
      () =>
        generateSpecDoc({
          kind,
          discovery,
          prototype,
          gaps,
          respostas,
          prd: latestPrd?.content_md ?? null,
          productName: project.name,
        })
    );

    const { data: last } = await admin
      .from("project_docs")
      .select("version")
      .eq("project_id", project.id)
      .eq("kind", kind)
      .order("version", { ascending: false })
      .limit(1)
      .maybeSingle();

    const { data: docRow, error: insertError } = await admin
      .from("project_docs")
      .insert({
        project_id: project.id,
        kind,
        content_md: content,
        version: (last?.version ?? 0) + 1,
        created_by: req.authUser?.id,
      })
      .select("kind, content_md, version, updated_at")
      .single();

    if (insertError) {
      console.error("Erro ao persistir documento:", insertError);
      res.status(500).json({ error: "Erro ao salvar o documento gerado." });
      return;
    }

    res.json({
      kind,
      label: SPEC_DOCS[kind].label,
      filename: SPEC_DOCS[kind].filename,
      content_md: content,
      version: docRow?.version ?? 1,
      updated_at: docRow?.updated_at ?? null,
    });
  } catch (error) {
    if (error instanceof AnthropicError) {
      res.status(502).json({ error: error.message });
      return;
    }
    const message =
      error instanceof Error ? error.message : "Erro desconhecido ao gerar o documento.";
    const isAbort =
      error instanceof Error &&
      (error.name === "AbortError" || /aborted|socket hang up/i.test(message));
    console.error("Erro ao gerar documento:", error);
    res.status(isAbort ? 502 : 500).json({
      error: isAbort
        ? "A geração foi interrompida (timeout ou conexão). Tente novamente."
        : "Erro ao gerar o documento.",
    });
  }
});
