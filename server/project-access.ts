import type { AuthedRequest } from "./auth";
import { getSupabaseAdmin } from "./supabase";
import {
  Gap,
  GapCategoria,
  GapSeveridade,
  GapSource,
  GapStatus,
} from "./types";

export function isSuper(req: AuthedRequest): boolean {
  return req.profile?.role === "super_admin";
}

/** Carrega o projeto se o usuário tiver acesso (mesmo time ou super_admin). */
export async function loadProjectForUser(
  req: AuthedRequest,
  projectId: string | string[]
): Promise<Record<string, any> | null> {
  const id = Array.isArray(projectId) ? projectId[0] : projectId;
  const admin = getSupabaseAdmin();
  const { data: project } = await admin
    .from("projects")
    .select("*")
    .eq("id", id)
    .single();

  if (!project) return null;
  if (!isSuper(req) && project.team_id !== req.profile?.team_id) {
    return null;
  }
  return project;
}

export interface GapRow {
  gap_hash: string;
  gap_key: string | null;
  categoria: GapCategoria;
  severidade: GapSeveridade;
  localizacao: string | null;
  titulo: string | null;
  descricao: string | null;
  sugestao: string | null;
  source: GapSource;
  status: GapStatus;
  resposta: string | null;
  figma_reminder_sent_at: string | null;
  figma_reminder_node_name: string | null;
}

/** Converte a linha do banco para o shape Gap usado pela IA e pelo cliente. */
export function mapGapRow(row: GapRow): Gap {
  return {
    id: row.gap_hash,
    chave: row.gap_key ?? row.gap_hash,
    categoria: row.categoria,
    severidade: row.severidade,
    localizacao: row.localizacao ?? "—",
    titulo: row.titulo ?? "",
    descricao: row.descricao ?? "",
    sugestao: row.sugestao ?? "",
    status: row.status,
    source: row.source,
    resposta: row.resposta ?? undefined,
    figma_reminder_sent_at: row.figma_reminder_sent_at,
    figma_reminder_node_name: row.figma_reminder_node_name,
  };
}

/** Converte um Gap em linha para insert/upsert (não mexe em resposta/status). */
export function gapToRow(gap: Gap, projectId: string, analysisId: string) {
  return {
    project_id: projectId,
    analysis_id: analysisId,
    gap_hash: gap.id,
    gap_key: gap.chave,
    categoria: gap.categoria,
    severidade: gap.severidade,
    localizacao: gap.localizacao,
    titulo: gap.titulo,
    descricao: gap.descricao,
    sugestao: gap.sugestao,
    source: gap.source,
  };
}
