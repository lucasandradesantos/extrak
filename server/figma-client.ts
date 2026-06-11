import {
  FigmaApiError,
  FigmaCommentsResponse,
  FigmaFileResponse,
} from "./types";

const FIGMA_API_BASE = "https://api.figma.com/v1";

async function figmaFetch<T>(path: string, token: string): Promise<T> {
  const response = await fetch(`${FIGMA_API_BASE}${path}`, {
    headers: {
      "X-Figma-Token": token,
    },
  });

  if (!response.ok) {
    let message = `Erro na API Figma (${response.status})`;

    try {
      const body = (await response.json()) as { err?: string; message?: string };
      message = body.err || body.message || message;
    } catch {
      // ignore JSON parse errors
    }

    throw new FigmaApiError(message, response.status);
  }

  return response.json() as Promise<T>;
}

export async function fetchFigmaFile(
  fileKey: string,
  token: string
): Promise<FigmaFileResponse> {
  return figmaFetch<FigmaFileResponse>(`/files/${fileKey}`, token);
}

export async function fetchFigmaComments(
  fileKey: string,
  token: string
): Promise<FigmaCommentsResponse> {
  return figmaFetch<FigmaCommentsResponse>(`/files/${fileKey}/comments`, token);
}
