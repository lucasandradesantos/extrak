import { fetchFigmaFile, fetchFigmaImages } from "./figma-client";
import type { SourceKind } from "./figma-service";
import type { FigmaNode } from "./types";

const MAX_PREVIEW_NODES = 20;
const IMAGE_BATCH_SIZE = 30;
const SCREEN_TYPES = new Set(["FRAME", "COMPONENT", "COMPONENT_SET"]);
const DISCOVERY_PREVIEW_TYPES = new Set(["SECTION", "FRAME"]);

export interface PreviewNodeRef {
  id: string;
  name: string;
  page: string;
}

export interface PreviewImage {
  id: string;
  name: string;
  page: string;
  url: string | null;
}

export interface ProjectPreviewResult {
  fileName: string;
  images: PreviewImage[];
}

function getFigmaToken(): string {
  const token = process.env.FIGMA_TOKEN;
  if (!token || token === "seu_token_figma_aqui") {
    throw new Error(
      "FIGMA_TOKEN não configurado no servidor. Defina a variável de ambiente."
    );
  }
  return token;
}

export function collectPreviewNodes(
  document: FigmaNode,
  kind: SourceKind
): PreviewNodeRef[] {
  const nodes: PreviewNodeRef[] = [];

  for (const page of document.children ?? []) {
    if (page.type !== "CANVAS") continue;
    const pageName = page.name;

    for (const child of page.children ?? []) {
      if (nodes.length >= MAX_PREVIEW_NODES) break;

      if (kind === "prototype") {
        if (SCREEN_TYPES.has(child.type)) {
          nodes.push({ id: child.id, name: child.name, page: pageName });
        } else if (child.type === "SECTION") {
          for (const inner of child.children ?? []) {
            if (nodes.length >= MAX_PREVIEW_NODES) break;
            if (SCREEN_TYPES.has(inner.type)) {
              nodes.push({
                id: inner.id,
                name: inner.name,
                page: `${pageName} › ${child.name}`,
              });
            }
          }
        }
      } else if (DISCOVERY_PREVIEW_TYPES.has(child.type)) {
        nodes.push({ id: child.id, name: child.name, page: pageName });
      }
    }

    if (nodes.length >= MAX_PREVIEW_NODES) break;
  }

  if (nodes.length === 0) {
    const firstPage = document.children?.[0];
    if (firstPage?.id) {
      nodes.push({ id: firstPage.id, name: firstPage.name, page: firstPage.name });
    }
  }

  return nodes;
}

async function fetchImagesInBatches(
  fileKey: string,
  nodes: PreviewNodeRef[],
  token: string
): Promise<Record<string, string | null>> {
  const merged: Record<string, string | null> = {};

  for (let i = 0; i < nodes.length; i += IMAGE_BATCH_SIZE) {
    const batch = nodes.slice(i, i + IMAGE_BATCH_SIZE);
    const ids = batch.map((n) => n.id);
    const images = await fetchFigmaImages(fileKey, ids, token, 1);
    Object.assign(merged, images);
  }

  return merged;
}

export async function buildProjectPreview(
  fileKey: string,
  kind: SourceKind
): Promise<ProjectPreviewResult> {
  const token = getFigmaToken();
  const file = await fetchFigmaFile(fileKey, token);
  const nodes = collectPreviewNodes(file.document, kind);
  const imageMap = await fetchImagesInBatches(fileKey, nodes, token);

  return {
    fileName: file.name,
    images: nodes.map((node) => ({
      ...node,
      url: imageMap[node.id] ?? null,
    })),
  };
}
