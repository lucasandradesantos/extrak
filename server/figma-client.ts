import { humanizeFigmaApiError } from "./figma-errors";
import {
  FigmaApiError,
  FigmaCommentsResponse,
  FigmaFileResponse,
  FigmaNodesResponse,
} from "./types";

const FIGMA_API_BASE = "https://api.figma.com/v1";

async function figmaFetch<T>(
  path: string,
  token: string,
  options: { method?: string; body?: unknown } = {}
): Promise<T> {
  const response = await fetch(`${FIGMA_API_BASE}${path}`, {
    method: options.method ?? "GET",
    headers: {
      "X-Figma-Token": token,
      ...(options.body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });

  if (!response.ok) {
    let message = `Erro na API Figma (${response.status})`;

    try {
      const body = (await response.json()) as { err?: string; message?: string };
      message = body.err || body.message || message;
    } catch {
      // ignore JSON parse errors
    }

    throw new FigmaApiError(humanizeFigmaApiError(message), response.status);
  }

  return response.json() as Promise<T>;
}

export async function fetchFigmaFile(
  fileKey: string,
  token: string
): Promise<FigmaFileResponse> {
  return figmaFetch<FigmaFileResponse>(`/files/${fileKey}`, token);
}

const NODE_IDS_BATCH = 40;

/** Busca nós específicos (ex.: nós de estilos) com fills, tipografia e efeitos. */
export async function fetchFigmaNodes(
  fileKey: string,
  nodeIds: string[],
  token: string
): Promise<FigmaNodesResponse["nodes"]> {
  if (nodeIds.length === 0) return {};

  const merged: FigmaNodesResponse["nodes"] = {};
  for (let i = 0; i < nodeIds.length; i += NODE_IDS_BATCH) {
    const batch = nodeIds.slice(i, i + NODE_IDS_BATCH);
    const params = new URLSearchParams({ ids: batch.join(",") });
    const data = await figmaFetch<FigmaNodesResponse>(
      `/files/${fileKey}/nodes?${params.toString()}`,
      token
    );
    Object.assign(merged, data.nodes ?? {});
  }
  return merged;
}

/**
 * Variáveis locais do arquivo. Requer scope `file_variables:read` no token.
 * Retorna null se indisponível (403) — a extração segue só com estilos.
 */
export async function fetchFigmaVariablesLocal(
  fileKey: string,
  token: string
): Promise<unknown | null> {
  try {
    const response = await fetch(
      `${FIGMA_API_BASE}/files/${fileKey}/variables/local`,
      {
        headers: { "X-Figma-Token": token },
      }
    );
    if (!response.ok) return null;
    const data = (await response.json()) as { meta?: unknown };
    return data.meta ?? null;
  } catch {
    return null;
  }
}

export async function fetchFigmaComments(
  fileKey: string,
  token: string
): Promise<FigmaCommentsResponse> {
  return figmaFetch<FigmaCommentsResponse>(`/files/${fileKey}/comments`, token);
}

export interface FigmaImagesResponse {
  err: string | null;
  images: Record<string, string | null>;
}

export async function fetchFigmaImages(
  fileKey: string,
  nodeIds: string[],
  token: string,
  scale = 1
): Promise<Record<string, string | null>> {
  if (nodeIds.length === 0) return {};

  const params = new URLSearchParams({
    ids: nodeIds.join(","),
    format: "png",
    scale: String(scale),
  });

  const data = await figmaFetch<FigmaImagesResponse>(
    `/images/${fileKey}?${params.toString()}`,
    token
  );

  return data.images ?? {};
}

export interface FigmaPostCommentResponse {
  id: string;
}

export async function postFigmaComment(
  fileKey: string,
  message: string,
  nodeId: string,
  token: string,
  nodeOffset: { x: number; y: number } = { x: 80, y: 80 }
): Promise<FigmaPostCommentResponse> {
  return figmaFetch<FigmaPostCommentResponse>(`/files/${fileKey}/comments`, token, {
    method: "POST",
    body: {
      message,
      client_meta: {
        node_id: nodeId,
        node_offset: nodeOffset,
      },
    },
  });
}
