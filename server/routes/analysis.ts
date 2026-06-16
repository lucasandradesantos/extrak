import { Router } from "express";
import { AnthropicError } from "../anthropic-client";
import type { AuthedRequest } from "../auth";
import {
  chunkDiscovery,
  compareDiscoveryPrototype,
  critiqueDiscoveryChunk,
  generatePrd,
} from "../analysis-service";
import { refreshProjectSources } from "../figma-service";
import { fileKeyForGapSource, postGapReminder } from "../figma-comments";
import { diffGaps } from "../gaps";
import {
  type GapRow,
  gapToRow,
  loadProjectForUser,
  mapGapRow,
} from "../project-access";
import { getSupabaseAdmin } from "../supabase";
import { FigmaApiError, Gap } from "../types";

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

  res.status(201).json({
    analysisId: analysis.id,
    jobId: job.id,
    total: totalSteps,
    processed: 0,
    status: "running",
  });
});

// Processa o próximo chunk da análise corrente (curto o bastante para 60s).
analysisRouter.post("/:id/analyze/step", async (req: AuthedRequest, res) => {
  const project = await loadProjectForUser(req, req.params.id);
  if (!project) {
    res.status(404).json({ error: "Projeto não encontrado." });
    return;
  }

  const admin = getSupabaseAdmin();
  const analysis = await getLatestAnalysis(project.id);
  if (!analysis) {
    res.status(400).json({ error: "Nenhuma análise iniciada." });
    return;
  }

  const { data: job } = await admin
    .from("analysis_jobs")
    .select("*")
    .eq("analysis_id", analysis.id)
    .maybeSingle();

  if (!job) {
    res.status(400).json({ error: "Job de análise não encontrado." });
    return;
  }

  if (job.status === "done") {
    const gaps = await readGaps(analysis.id);
    res.json({ status: "done", processed: job.total_chunks, total: job.total_chunks, gaps });
    return;
  }

  // Processa o snapshot congelado da rodada (cai para o material atual em
  // análises antigas, anteriores ao snapshot).
  let discovery: string = analysis.discovery_snapshot ?? "";
  let prototype: string | null = analysis.prototype_snapshot ?? null;
  if (!discovery) {
    const current = await getSourceTexts(project.id);
    discovery = current.discovery;
    prototype = current.prototype;
  }
  const chunks = chunkDiscovery(discovery);
  const hasPrototype = Boolean(prototype && prototype.trim());
  // Último passo (quando há protótipo) é a comparação Discovery×Protótipo inteira.
  const totalSteps = chunks.length + (hasPrototype ? 1 : 0);
  const idx = job.processed_chunks;

  // Mantém total_chunks alinhado ao plano atual de passos.
  if (job.total_chunks !== totalSteps) {
    await admin
      .from("analysis_jobs")
      .update({ total_chunks: totalSteps })
      .eq("id", job.id);
  }

  if (idx >= totalSteps) {
    await finishJob(job.id, analysis.id);
    const gaps = await readGaps(analysis.id);
    res.json({ status: "done", processed: totalSteps, total: totalSteps, gaps });
    return;
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
      // Comparação numa única chamada com o Discovery COMPLETO + Protótipo.
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
      // Crítica do Discovery por trecho (sem protótipo — evita falsos positivos).
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
        const row = gapToRow(gap, project.id, analysis.id) as Record<string, unknown>;
        // Carrega a resposta anterior (reprocessamento) para preservar o contexto.
        if (respostas[gap.id]?.trim()) {
          row.resposta = respostas[gap.id].trim();
        }
        return row;
      });
      await admin.from("gaps").upsert(rows, { onConflict: "analysis_id,gap_hash" });
    }

    const processed = idx + 1;
    const done = processed >= totalSteps;

    await admin
      .from("analysis_jobs")
      .update({
        processed_chunks: processed,
        status: done ? "done" : "running",
      })
      .eq("id", job.id);

    if (done) {
      await admin.from("analyses").update({ status: "done" }).eq("id", analysis.id);
      const allGaps = await readGaps(analysis.id);
      res.json({ status: "done", processed, total: totalSteps, gaps: allGaps });
      return;
    }

    res.json({ status: "running", processed, total: totalSteps });
  } catch (error) {
    await admin
      .from("analysis_jobs")
      .update({ status: "error", error: error instanceof Error ? error.message : "erro" })
      .eq("id", job.id);
    await admin.from("analyses").update({ status: "error" }).eq("id", analysis.id);

    if (error instanceof AnthropicError) {
      res.status(502).json({ error: error.message });
      return;
    }
    console.error("Erro no step de análise:", error);
    res.status(500).json({ error: "Erro ao processar a análise." });
  }
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
    .select("id, round, status, created_at, source_metadata")
    .eq("project_id", project.id)
    .order("round", { ascending: false });

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
    .select("id, round, project_id, created_at, source_metadata")
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
    },
    to: {
      id: toRound.id,
      round: toRound.round,
      created_at: toRound.created_at,
      source_metadata: toRound.source_metadata ?? null,
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
  res.json({
    id: round.id,
    round: round.round,
    status: round.status,
    created_at: round.created_at,
    source_metadata: round.source_metadata ?? null,
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

  for (const gapId of ids) {
    const update: Record<string, unknown> = {};
    if (responses && gapId in responses) update.resposta = responses[gapId];
    if (statuses && gapId in statuses) update.status = statuses[gapId];
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

// Gera (e persiste) o PRD. Bloqueia se houver gap de severidade alta em aberto.
analysisRouter.post("/:id/prd", async (req: AuthedRequest, res) => {
  const project = await loadProjectForUser(req, req.params.id);
  if (!project) {
    res.status(404).json({ error: "Projeto não encontrado." });
    return;
  }

  const admin = getSupabaseAdmin();
  const analysis = await getLatestAnalysis(project.id);
  const gaps = analysis ? await readGaps(analysis.id) : [];

  const bloqueantes = gaps.filter(
    (g) => g.severidade === "alta" && g.status !== "resolvido"
  );
  if (bloqueantes.length > 0) {
    res.status(409).json({
      error: `Existem ${bloqueantes.length} gap(s) de severidade alta em aberto. Resolva-os antes de gerar o PRD.`,
    });
    return;
  }

  const { discovery, prototype } = await getSourceTexts(project.id);
  if (!discovery.trim()) {
    res.status(400).json({ error: "O Discovery deste projeto está vazio." });
    return;
  }

  const respostas: Record<string, string> = {};
  for (const gap of gaps) {
    if (gap.resposta?.trim()) respostas[gap.id] = gap.resposta.trim();
  }

  try {
    const prd = await generatePrd({
      discovery,
      prototype,
      gaps,
      respostas,
      productName: project.name,
    });

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

    res.json({ prd, prdRow });
  } catch (error) {
    if (error instanceof AnthropicError) {
      res.status(502).json({ error: error.message });
      return;
    }
    console.error("Erro ao gerar PRD:", error);
    res.status(500).json({ error: "Erro ao gerar o PRD." });
  }
});

async function readGaps(analysisId: string): Promise<Gap[]> {
  const admin = getSupabaseAdmin();
  const { data } = await admin
    .from("gaps")
    .select("*")
    .eq("analysis_id", analysisId);
  return ((data ?? []) as GapRow[]).map(mapGapRow);
}

async function finishJob(jobId: string, analysisId: string): Promise<void> {
  const admin = getSupabaseAdmin();
  await admin.from("analysis_jobs").update({ status: "done" }).eq("id", jobId);
  await admin.from("analyses").update({ status: "done" }).eq("id", analysisId);
}
