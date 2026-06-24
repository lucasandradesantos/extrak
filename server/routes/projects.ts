import { Router } from "express";
import { pickActor, resolveActors } from "../actors";
import type { AuthedRequest } from "../auth";
import { extractDiscovery, extractPrototype } from "../figma-service";
import { buildProjectPreview } from "../figma-preview";
import { parseFileKey } from "../parse-url";
import {
  type GapRow,
  isSuper,
  loadProjectForUser,
  mapGapRow,
} from "../project-access";
import { getSupabaseAdmin } from "../supabase";
import { FigmaApiError, ParseUrlError } from "../types";

export const projectsRouter = Router();

// Criar projeto: extrai Discovery (FigJam) e, se informado, Protótipo (Figma).
projectsRouter.post("/", async (req: AuthedRequest, res) => {
  const { name, discoveryUrl, prototypeUrl, teamId } = req.body as {
    name?: string;
    discoveryUrl?: string;
    prototypeUrl?: string;
    teamId?: string;
  };

  if (!discoveryUrl || typeof discoveryUrl !== "string") {
    res.status(400).json({ error: "A URL do Discovery (FigJam) é obrigatória." });
    return;
  }

  // Determina o time do projeto.
  let targetTeam = req.profile?.team_id ?? null;
  if (isSuper(req) && teamId) targetTeam = teamId;
  if (!targetTeam) {
    res.status(400).json({
      error: "Seu usuário não está associado a um time. Contate o administrador.",
    });
    return;
  }

  let discoveryKey: string;
  let prototypeKey: string | null = null;
  try {
    discoveryKey = parseFileKey(discoveryUrl);
    if (prototypeUrl && prototypeUrl.trim()) {
      prototypeKey = parseFileKey(prototypeUrl);
    }
  } catch (error) {
    if (error instanceof ParseUrlError) {
      res.status(400).json({ error: error.message });
      return;
    }
    throw error;
  }

  try {
    const discovery = await extractDiscovery(discoveryKey);
    const prototype = prototypeKey ? await extractPrototype(prototypeKey) : null;

    const admin = getSupabaseAdmin();
    const { data: project, error: projectError } = await admin
      .from("projects")
      .insert({
        team_id: targetTeam,
        created_by: req.authUser?.id,
        name: name?.trim() || discovery.metadata.name,
        discovery_url: discoveryUrl,
        discovery_file_key: discoveryKey,
        prototype_url: prototypeUrl?.trim() || null,
        prototype_file_key: prototypeKey,
        status: "extracted",
      })
      .select("*")
      .single();

    if (projectError || !project) {
      res.status(500).json({ error: "Erro ao salvar o projeto." });
      return;
    }

    const sources: Array<{
      project_id: string;
      kind: "discovery" | "prototype";
      figma_file_key: string;
      metadata: unknown;
      discovery_text: string;
    }> = [
      {
        project_id: project.id,
        kind: "discovery",
        figma_file_key: discoveryKey,
        metadata: discovery.metadata,
        discovery_text: discovery.text,
      },
    ];
    if (prototype) {
      sources.push({
        project_id: project.id,
        kind: "prototype",
        figma_file_key: prototypeKey!,
        metadata: prototype.metadata,
        discovery_text: prototype.text,
      });
    }

    await admin.from("project_sources").insert(sources);

    res.status(201).json({ project });
  } catch (error) {
    if (error instanceof FigmaApiError) {
      const status =
        error.statusCode === 403 ? 403 : error.statusCode === 404 ? 404 : 502;
      res.status(status).json({ error: error.message });
      return;
    }
    console.error("Erro ao criar projeto:", error);
    res
      .status(500)
      .json({ error: error instanceof Error ? error.message : "Erro interno." });
  }
});

// Listar projetos do time (super_admin vê todos).
projectsRouter.get("/", async (req: AuthedRequest, res) => {
  const admin = getSupabaseAdmin();
  let query = admin
    .from("projects")
    .select(
      "id, name, team_id, status, discovery_url, prototype_url, created_at, updated_at, created_by"
    )
    .order("updated_at", { ascending: false });

  if (!isSuper(req)) {
    if (!req.profile?.team_id) {
      res.json({ projects: [] });
      return;
    }
    query = query.eq("team_id", req.profile.team_id);
  }

  const { data, error } = await query;
  if (error) {
    res.status(500).json({ error: "Erro ao listar projetos." });
    return;
  }

  const projects = data ?? [];
  const ids = projects.map((p) => p.id);
  const projectActors = await resolveActors(projects.map((p) => p.created_by));

  let jobByProject = new Map<
    string,
    { status: string; processed_chunks: number; total_chunks: number }
  >();

  if (ids.length > 0) {
    const { data: jobs } = await admin
      .from("analysis_jobs")
      .select("project_id, status, processed_chunks, total_chunks, updated_at")
      .in("project_id", ids)
      .order("updated_at", { ascending: false });

    for (const job of jobs ?? []) {
      if (!jobByProject.has(job.project_id)) {
        jobByProject.set(job.project_id, job);
      }
    }
  }

  const enriched = projects.map((p) => {
    const job = jobByProject.get(p.id);
    return {
      ...p,
      created_by: pickActor(projectActors, p.created_by),
      analysis_status: job?.status ?? null,
      analysis_progress: job
        ? { processed: job.processed_chunks, total: job.total_chunks }
        : null,
    };
  });

  res.json({ projects: enriched });
});

// Preview visual via API Figma (usa FIGMA_TOKEN do servidor — sem login do usuário).
projectsRouter.get("/:id/preview/:kind", async (req: AuthedRequest, res) => {
  const kind = req.params.kind;
  if (kind !== "discovery" && kind !== "prototype") {
    res.status(400).json({ error: "Tipo de preview inválido." });
    return;
  }

  const project = await loadProjectForUser(req, req.params.id);
  if (!project) {
    res.status(404).json({ error: "Projeto não encontrado." });
    return;
  }

  const fileKey =
    kind === "discovery" ? project.discovery_file_key : project.prototype_file_key;
  if (!fileKey) {
    res.status(404).json({ error: "Arquivo Figma não encontrado para este projeto." });
    return;
  }

  try {
    const preview = await buildProjectPreview(fileKey, kind);
    res.json(preview);
  } catch (error) {
    if (error instanceof FigmaApiError) {
      const status =
        error.statusCode === 403 ? 403 : error.statusCode === 404 ? 404 : 502;
      res.status(status).json({ error: error.message });
      return;
    }
    console.error("Erro ao gerar preview:", error);
    res.status(500).json({
      error: error instanceof Error ? error.message : "Erro ao gerar preview.",
    });
  }
});

// Detalhe do projeto com sources, gaps da última análise, PRD e job.
projectsRouter.get("/:id", async (req: AuthedRequest, res) => {
  const project = await loadProjectForUser(req, req.params.id);
  if (!project) {
    res.status(404).json({ error: "Projeto não encontrado." });
    return;
  }

  const admin = getSupabaseAdmin();

  const { data: sources } = await admin
    .from("project_sources")
    .select("kind, figma_file_key, metadata, discovery_text, created_at")
    .eq("project_id", project.id);

  const { data: latestAnalysis } = await admin
    .from("analyses")
    .select("*")
    .eq("project_id", project.id)
    .order("round", { ascending: false })
    .limit(1)
    .maybeSingle();

  let gaps: ReturnType<typeof mapGapRow>[] = [];
  let job: unknown = null;
  if (latestAnalysis) {
    const { data: gapRows } = await admin
      .from("gaps")
      .select("*")
      .eq("analysis_id", latestAnalysis.id)
      .order("severidade");
    const rows = (gapRows ?? []) as GapRow[];
    const gapActors = await resolveActors(
      rows.flatMap((row) => [
        row.resolved_by,
        row.resposta_by,
        row.figma_reminder_sent_by,
      ])
    );
    gaps = rows.map((row) => mapGapRow(row, gapActors));

    const { data: jobRow } = await admin
      .from("analysis_jobs")
      .select("*")
      .eq("analysis_id", latestAnalysis.id)
      .maybeSingle();
    job = jobRow;
  }

  const detailActors = await resolveActors([
    project.created_by,
    latestAnalysis?.created_by,
  ]);

  const { data: latestPrd } = await admin
    .from("prds")
    .select("*")
    .eq("project_id", project.id)
    .order("version", { ascending: false })
    .limit(1)
    .maybeSingle();

  const { data: prdJob } = await admin
    .from("prd_jobs")
    .select("*")
    .eq("project_id", project.id)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  res.json({
    project: {
      ...project,
      created_by: pickActor(detailActors, project.created_by),
    },
    sources: sources ?? [],
    analysis: latestAnalysis
      ? {
          ...latestAnalysis,
          created_by: pickActor(detailActors, latestAnalysis.created_by),
        }
      : null,
    gaps,
    job,
    prd: latestPrd ?? null,
    prd_job: prdJob ?? null,
  });
});

// Atualiza nome e/ou URLs do projeto. Se as URLs mudarem, re-extrai do Figma.
projectsRouter.patch("/:id", async (req: AuthedRequest, res) => {
  const project = await loadProjectForUser(req, req.params.id);
  if (!project) {
    res.status(404).json({ error: "Projeto não encontrado." });
    return;
  }

  const { name, discoveryUrl, prototypeUrl } = req.body as {
    name?: string;
    discoveryUrl?: string;
    prototypeUrl?: string;
  };

  if (name === undefined && discoveryUrl === undefined && prototypeUrl === undefined) {
    res.status(400).json({ error: "Nenhum campo para atualizar." });
    return;
  }

  const admin = getSupabaseAdmin();
  const updates: Record<string, unknown> = {
    updated_at: new Date().toISOString(),
  };

  if (name !== undefined) {
    const trimmed = name.trim();
    if (!trimmed) {
      res.status(400).json({ error: "O nome do projeto não pode ser vazio." });
      return;
    }
    updates.name = trimmed;
  }

  let discoveryKey = project.discovery_file_key as string;
  let prototypeKey = (project.prototype_file_key as string | null) ?? null;
  let sourcesChanged = false;

  if (discoveryUrl !== undefined) {
    const trimmed = discoveryUrl.trim();
    if (!trimmed) {
      res.status(400).json({ error: "A URL do Discovery é obrigatória." });
      return;
    }
    try {
      const key = parseFileKey(trimmed);
      if (key !== project.discovery_file_key || trimmed !== project.discovery_url) {
        discoveryKey = key;
        updates.discovery_url = trimmed;
        updates.discovery_file_key = key;
        sourcesChanged = true;
      }
    } catch (error) {
      if (error instanceof ParseUrlError) {
        res.status(400).json({ error: error.message });
        return;
      }
      throw error;
    }
  }

  if (prototypeUrl !== undefined) {
    const trimmed = prototypeUrl.trim();
    if (trimmed) {
      try {
        const key = parseFileKey(trimmed);
        if (key !== project.prototype_file_key || trimmed !== project.prototype_url) {
          prototypeKey = key;
          updates.prototype_url = trimmed;
          updates.prototype_file_key = key;
          sourcesChanged = true;
        }
      } catch (error) {
        if (error instanceof ParseUrlError) {
          res.status(400).json({ error: error.message });
          return;
        }
        throw error;
      }
    } else if (project.prototype_file_key || project.prototype_url) {
      prototypeKey = null;
      updates.prototype_url = null;
      updates.prototype_file_key = null;
      sourcesChanged = true;
    }
  }

  try {
    if (sourcesChanged) {
      const discovery = await extractDiscovery(discoveryKey);
      const prototype = prototypeKey ? await extractPrototype(prototypeKey) : null;

      await admin
        .from("project_sources")
        .upsert(
          [
            {
              project_id: project.id,
              kind: "discovery",
              figma_file_key: discoveryKey,
              metadata: discovery.metadata,
              discovery_text: discovery.text,
            },
          ],
          { onConflict: "project_id,kind" }
        );

      if (prototype && prototypeKey) {
        await admin.from("project_sources").upsert(
          [
            {
              project_id: project.id,
              kind: "prototype",
              figma_file_key: prototypeKey,
              metadata: prototype.metadata,
              discovery_text: prototype.text,
            },
          ],
          { onConflict: "project_id,kind" }
        );
      } else {
        await admin
          .from("project_sources")
          .delete()
          .eq("project_id", project.id)
          .eq("kind", "prototype");
      }
    }

    const { data: updated, error } = await admin
      .from("projects")
      .update(updates)
      .eq("id", project.id)
      .select("*")
      .single();

    if (error || !updated) {
      res.status(500).json({ error: "Erro ao atualizar o projeto." });
      return;
    }

    const actors = await resolveActors([updated.created_by]);
    res.json({
      project: {
        ...updated,
        created_by: pickActor(actors, updated.created_by),
      },
    });
  } catch (error) {
    if (error instanceof FigmaApiError) {
      const status =
        error.statusCode === 403 ? 403 : error.statusCode === 404 ? 404 : 502;
      res.status(status).json({ error: error.message });
      return;
    }
    console.error("Erro ao atualizar projeto:", error);
    res
      .status(500)
      .json({ error: error instanceof Error ? error.message : "Erro interno." });
  }
});

projectsRouter.delete("/:id", async (req: AuthedRequest, res) => {
  const project = await loadProjectForUser(req, req.params.id);
  if (!project) {
    res.status(404).json({ error: "Projeto não encontrado." });
    return;
  }
  const admin = getSupabaseAdmin();
  const { error } = await admin.from("projects").delete().eq("id", project.id);
  if (error) {
    res.status(500).json({ error: "Erro ao remover projeto." });
    return;
  }
  res.json({ ok: true });
});
