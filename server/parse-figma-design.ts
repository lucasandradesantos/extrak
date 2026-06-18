import { DesignScreen, FigmaNode, ParsedDesign } from "./types";

const SCREEN_TYPES = new Set([
  "FRAME",
  "COMPONENT",
  "COMPONENT_SET",
  "INSTANCE",
]);

/** Seções de arquivo que costumam ser specs/anotações, não telas de produto. */
const SKIP_SECTION_PATTERNS = [
  /^annotations?$/i,
  /^specs?$/i,
  /^documentation$/i,
  /^archive$/i,
  /^deprecated$/i,
  /^backup$/i,
  /^old\s+/i,
];

const UI_NAME_PATTERNS =
  /button|btn|cta|input|field|link|tab|chip|badge|icon|avatar|nav|menu|card|modal|toast|checkbox|radio|switch|dropdown|select|header|footer|sidebar/i;

export interface ScreenNodeRef {
  id: string;
  name: string;
  page: string;
  sectionPath: string;
  node: FigmaNode;
}

function getBox(node: FigmaNode): { width: number; height: number } | null {
  const box = node.absoluteBoundingBox;
  if (!box || box.width <= 0 || box.height <= 0) return null;
  return { width: Math.round(box.width), height: Math.round(box.height) };
}

function isGenericFrameName(name: string): boolean {
  return /^(frame|group|container|rectangle|auto layout|stack|\d+)$/i.test(
    name.trim()
  );
}

function countTexts(node: FigmaNode): number {
  let count = 0;
  function walk(n: FigmaNode) {
    if (n.type === "TEXT" && n.characters?.trim()) count += 1;
    for (const child of n.children ?? []) walk(child);
  }
  walk(node);
  return count;
}

function hasInteractions(node: FigmaNode): boolean {
  if (node.transitionNodeID || (node.reactions?.length ?? 0) > 0) return true;
  for (const child of node.children ?? []) {
    if (hasInteractions(child)) return true;
  }
  return false;
}

function isScreenCandidate(node: FigmaNode): boolean {
  if (!SCREEN_TYPES.has(node.type)) return false;

  const box = getBox(node);
  if (!box) return false;

  const { width, height } = box;
  if (width < 200 || height < 300) return false;

  const mobileLike = width >= 280 && width <= 520 && height >= 480;
  const tabletLike = width >= 520 && width <= 1024 && height >= 600;
  const desktopLike = width >= 900 && height >= 500;
  const sizeOk = mobileLike || tabletLike || desktopLike;

  const texts = countTexts(node);
  const interactive = hasInteractions(node);

  if (sizeOk && (texts > 0 || interactive)) return true;

  if (width >= 320 && height >= 400 && texts >= 3) return true;

  if (
    height >= 500 &&
    width >= 300 &&
    !isGenericFrameName(node.name) &&
    (texts > 0 || interactive)
  ) {
    return true;
  }

  return false;
}

function isDescendant(ancestor: FigmaNode, targetId: string): boolean {
  for (const child of ancestor.children ?? []) {
    if (child.id === targetId) return true;
    if (isDescendant(child, targetId)) return true;
  }
  return false;
}

function sectionIsSkipped(sectionPath: string): boolean {
  if (!sectionPath) return false;
  const parts = sectionPath.split(" › ");
  return parts.some((part) =>
    SKIP_SECTION_PATTERNS.some((re) => re.test(part.trim()))
  );
}

function collectTexts(node: FigmaNode, acc: string[]): void {
  if (node.type === "TEXT" && node.characters) {
    const text = node.characters.replace(/\s+/g, " ").trim();
    if (text) acc.push(text);
  }
  for (const child of node.children ?? []) {
    collectTexts(child, acc);
  }
}

function collectUiLabels(node: FigmaNode, acc: Set<string>): void {
  const name = node.name?.trim();
  if (name && UI_NAME_PATTERNS.test(name) && !isGenericFrameName(name)) {
    acc.add(name);
  }
  if (
    node.type === "INSTANCE" &&
    name &&
    !isGenericFrameName(name) &&
    !node.characters
  ) {
    acc.add(name);
  }
  for (const child of node.children ?? []) {
    collectUiLabels(child, acc);
  }
}

interface TransitionInfo {
  destinationId: string;
  trigger?: string;
  action?: string;
}

function collectTransitions(node: FigmaNode, acc: TransitionInfo[]): void {
  if (node.transitionNodeID) {
    acc.push({ destinationId: node.transitionNodeID });
  }
  for (const reaction of node.reactions ?? []) {
    const dest = reaction.action?.destinationId;
    if (dest) {
      acc.push({
        destinationId: dest,
        trigger: reaction.trigger?.type,
        action: reaction.action?.type ?? reaction.action?.navigation,
      });
    }
  }
  for (const child of node.children ?? []) {
    collectTransitions(child, acc);
  }
}

function buildIdNameMap(node: FigmaNode, map: Map<string, string>): void {
  map.set(node.id, node.name);
  for (const child of node.children ?? []) {
    buildIdNameMap(child, map);
  }
}

function dedupeTexts(texts: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const text of texts) {
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(text);
  }
  return out;
}

function buildScreen(
  frame: FigmaNode,
  page: string,
  sectionPath: string
): DesignScreen {
  const texts: string[] = [];
  collectTexts(frame, texts);

  const labels = new Set<string>();
  collectUiLabels(frame, labels);

  const transitions: TransitionInfo[] = [];
  collectTransitions(frame, transitions);

  const box = getBox(frame);
  const transitionIds = [
    ...new Set(transitions.map((t) => t.destinationId)),
  ];

  return {
    id: frame.id,
    name: frame.name,
    page,
    sectionPath: sectionPath || undefined,
    dimensions: box ?? undefined,
    texts: dedupeTexts(texts),
    labels: labels.size > 0 ? [...labels] : undefined,
    transitionsTo: transitionIds,
    transitionDetails:
      transitions.length > 0
        ? transitions.map((t) => ({
            destinationId: t.destinationId,
            trigger: t.trigger,
            action: t.action,
          }))
        : undefined,
  };
}

/**
 * Percorre a árvore inteira de cada página e identifica telas reais (frames
 * folha com dimensões de tela), em vez de só filhos diretos de CANVAS/SECTION.
 */
export function collectDesignScreenNodes(
  document: FigmaNode
): ScreenNodeRef[] {
  const candidates: Array<{
    node: FigmaNode;
    page: string;
    sectionPath: string;
  }> = [];

  function walkPage(
    node: FigmaNode,
    pageName: string,
    sectionPath: string
  ): void {
    let nextSection = sectionPath;
    if (node.type === "SECTION") {
      nextSection = sectionPath
        ? `${sectionPath} › ${node.name}`
        : node.name;
    }

    const inSkippedSection = sectionIsSkipped(nextSection);

    if (isScreenCandidate(node)) {
      const include =
        !inSkippedSection || hasInteractions(node);
      if (include) {
        candidates.push({
          node,
          page: pageName,
          sectionPath: nextSection,
        });
      }
    }

    for (const child of node.children ?? []) {
      walkPage(child, pageName, nextSection);
    }
  }

  for (const page of document.children ?? []) {
    if (page.type !== "CANVAS") continue;
    for (const child of page.children ?? []) {
      walkPage(child, page.name, "");
    }
  }

  return candidates
    .filter((candidate) => {
      return !candidates.some(
        (other) =>
          other.node.id !== candidate.node.id &&
          isDescendant(candidate.node, other.node.id)
      );
    })
    .map(({ node, page, sectionPath }) => ({
      id: node.id,
      name: node.name,
      page: sectionPath ? `${page} › ${sectionPath}` : page,
      sectionPath,
      node,
    }));
}

export function parseFigmaDesign(document: FigmaNode): ParsedDesign {
  const screens: DesignScreen[] = [];
  const pages: string[] = [];

  for (const page of document.children ?? []) {
    if (page.type !== "CANVAS") continue;
    pages.push(page.name);
  }

  for (const ref of collectDesignScreenNodes(document)) {
    const pageName = ref.page.includes(" › ")
      ? ref.page.split(" › ")[0]
      : ref.page;
    screens.push(buildScreen(ref.node, pageName, ref.sectionPath));
  }

  screens.sort((a, b) => {
    const pageCmp = a.page.localeCompare(b.page, "pt-BR");
    if (pageCmp !== 0) return pageCmp;
    return a.name.localeCompare(b.name, "pt-BR");
  });

  const textNodes = screens.reduce((sum, s) => sum + s.texts.length, 0);
  const flows = screens.reduce((sum, s) => sum + s.transitionsTo.length, 0);

  return {
    summary: {
      pages: pages.length,
      screens: screens.length,
      textNodes,
      flows,
    },
    pages,
    screens,
  };
}

/**
 * Texto estruturado do protótipo para a IA: páginas, telas, textos visíveis,
 * elementos nomeados e fluxos de navegação (com destinos resolvidos).
 */
export function formatDesignAsText(
  document: FigmaNode,
  parsed: ParsedDesign
): string {
  const idToName = new Map<string, string>();
  buildIdNameMap(document, idToName);

  const lines: string[] = [];
  lines.push(
    `# Protótipo Figma — ${parsed.summary.screens} tela(s), ${parsed.summary.textNodes} texto(s) visível(is), ${parsed.summary.flows} link(s) de fluxo em ${parsed.summary.pages} página(s)`
  );
  lines.push("");

  let currentPage = "";
  for (const screen of parsed.screens) {
    if (screen.page !== currentPage) {
      currentPage = screen.page;
      lines.push(`## Página: ${currentPage}`);
      lines.push("");
    }

    const dim =
      screen.dimensions != null
        ? ` (${screen.dimensions.width}×${screen.dimensions.height})`
        : "";
    lines.push(`### Tela: ${screen.name}${dim}`);

    if (screen.sectionPath && !currentPage.includes(screen.sectionPath)) {
      lines.push(`  Seção: ${screen.sectionPath}`);
    }

    if (screen.texts.length > 0) {
      lines.push("  Textos:");
      for (const text of screen.texts) {
        lines.push(`  - ${text}`);
      }
    }

    if (screen.labels && screen.labels.length > 0) {
      lines.push(`  Elementos UI: ${screen.labels.join(" | ")}`);
    }

    if (screen.transitionDetails && screen.transitionDetails.length > 0) {
      lines.push("  Navegação:");
      for (const t of screen.transitionDetails) {
        const dest = idToName.get(t.destinationId) ?? t.destinationId;
        const parts: string[] = [dest];
        if (t.trigger) parts.push(`gatilho: ${t.trigger}`);
        if (t.action) parts.push(`ação: ${t.action}`);
        lines.push(`  - → ${parts.join(", ")}`);
      }
    } else if (screen.transitionsTo.length > 0) {
      const dests = screen.transitionsTo
        .map((id) => idToName.get(id) ?? id)
        .join(", ");
      lines.push(`  Navega para: ${dests}`);
    }

    lines.push("");
  }

  return lines.join("\n").trim();
}
