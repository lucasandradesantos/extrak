import { fetchFigmaFile, postFigmaComment } from "./figma-client";
import type { Gap, GapSource } from "./types";
import type { FigmaNode } from "./types";

function getFigmaToken(): string {
  const token = process.env.FIGMA_TOKEN;
  if (!token || token === "seu_token_figma_aqui") {
    throw new Error(
      "FIGMA_TOKEN não configurado no servidor. Defina a variável de ambiente."
    );
  }
  return token;
}

function normalizeLabel(value: string): string {
  return value.toLowerCase().trim().replace(/\s+/g, " ");
}

const NON_COMMENT_TARGET_TYPES = new Set(["DOCUMENT", "CANVAS"]);

function segmentMatches(a: string, b: string): boolean {
  if (!a || !b) return false;
  return a === b || a.includes(b) || b.includes(a);
}

function scoreLocalizacaoMatch(
  localizacaoSegments: string[],
  nodePath: string[],
  node: FigmaNode
): number {
  if (localizacaoSegments.length === 0) return 0;

  const pathSegments = nodePath.map(normalizeLabel).filter(Boolean);
  const nodeName = normalizeLabel(node.name);
  if (!nodeName) return 0;
  const lastSegment = localizacaoSegments[localizacaoSegments.length - 1];
  let score = 0;

  if (segmentMatches(nodeName, lastSegment)) {
    score += 20;
  }

  for (const segment of localizacaoSegments.slice(0, -1)) {
    if (pathSegments.some((part) => segmentMatches(part, segment))) {
      score += 5;
    }
  }

  if (pathSegments.some((part) => segmentMatches(part, lastSegment))) {
    score += 4;
  }

  if (node.type === "SECTION") score += 3;
  else if (node.type === "FRAME") score += 2;
  else if (node.type === "STICKY" || node.type === "SHAPE_WITH_TEXT") score += 1;

  return score;
}

function commentOffsetForNode(node: FigmaNode): { x: number; y: number } {
  const box = node.absoluteBoundingBox;
  if (box && box.width > 0 && box.height > 0) {
    return {
      x: Math.max(20, Math.round(box.width / 2)),
      y: Math.max(20, Math.round(box.height / 2)),
    };
  }
  return { x: 80, y: 80 };
}

/** Tenta localizar no arquivo o nó mais próximo da localização do gap. */
export function findNodeForLocalizacao(
  document: FigmaNode,
  localizacao: string
): FigmaNode | null {
  const segments = localizacao
    .split(">")
    .map((s) => normalizeLabel(s))
    .filter(Boolean);

  const matches: { node: FigmaNode; score: number }[] = [];

  function walk(node: FigmaNode, path: string[]): void {
    const currentPath = node.type === "CANVAS" ? [...path, node.name] : path;

    if (!NON_COMMENT_TARGET_TYPES.has(node.type)) {
      const score = scoreLocalizacaoMatch(segments, currentPath, node);
      if (score > 0) matches.push({ node, score });
    }

    const nextPath =
      node.type === "SECTION" ? [...currentPath, node.name] : currentPath;

    for (const child of node.children ?? []) {
      walk(child, nextPath);
    }
  }

  for (const page of document.children ?? []) {
    walk(page, []);
  }

  matches.sort((a, b) => b.score - a.score);

  const best = matches[0];
  if (best && best.score >= 8) {
    return best.node;
  }

  if (segments.length > 0) {
    const lastSegment = segments[segments.length - 1];
    const byName = matches
      .filter(({ node }) => segmentMatches(normalizeLabel(node.name), lastSegment))
      .sort((a, b) => b.score - a.score);
    if (byName[0]) return byName[0].node;
  }

  const firstSection = matches.find(({ node }) => node.type === "SECTION");
  return firstSection?.node ?? null;
}

export function fileKeyForGapSource(
  source: GapSource,
  discoveryFileKey: string | null,
  prototypeFileKey: string | null
): string | null {
  if (source === "prototype") return prototypeFileKey;
  return discoveryFileKey ?? prototypeFileKey;
}

function buildReminderMessage(gap: Gap, projectName: string): string {
  const lines = [
    "🔔 Extrak — lembrete de gap de QA",
    "",
    `Projeto: ${projectName}`,
    `Severidade: ${gap.severidade}`,
    `Origem: ${gap.source}`,
    `Local: ${gap.localizacao}`,
    "",
    gap.titulo,
    "",
    gap.descricao,
  ];
  if (gap.sugestao?.trim()) {
    lines.push("", `Sugestão: ${gap.sugestao}`);
  }
  if (gap.resposta?.trim()) {
    lines.push("", `Resposta do time: ${gap.resposta.trim()}`);
  }
  lines.push("", "— Enviado via Extrak (from Figma)");
  return lines.join("\n");
}

export function buildFigmaNodeUrl(fileKey: string, nodeId: string): string {
  return `https://www.figma.com/file/${fileKey}?node-id=${nodeId.replace(/:/g, "-")}`;
}

export async function postGapReminder(params: {
  fileKey: string;
  gap: Gap;
  projectName: string;
}): Promise<{
  commentId: string;
  nodeId: string;
  nodeName: string;
  fileKey: string;
  figmaUrl: string;
}> {
  const token = getFigmaToken();
  const file = await fetchFigmaFile(params.fileKey, token);
  const node = findNodeForLocalizacao(file.document, params.gap.localizacao);

  if (!node?.id) {
    throw new Error("Não foi possível localizar um nó no Figma para anexar o comentário.");
  }

  const comment = await postFigmaComment(
    params.fileKey,
    buildReminderMessage(params.gap, params.projectName),
    node.id,
    token,
    commentOffsetForNode(node)
  );

  return {
    commentId: comment.id,
    nodeId: node.id,
    nodeName: node.name,
    fileKey: params.fileKey,
    figmaUrl: buildFigmaNodeUrl(params.fileKey, node.id),
  };
}
