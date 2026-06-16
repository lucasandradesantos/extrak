import { DesignScreen, FigmaNode, ParsedDesign } from "./types";

const MAX_TEXTS_PER_SCREEN = 60;

function collectTexts(node: FigmaNode, acc: string[]): void {
  if (node.type === "TEXT" && node.characters) {
    const text = node.characters.trim();
    if (text) acc.push(text);
  }
  for (const child of node.children ?? []) {
    collectTexts(child, acc);
  }
}

function collectTransitions(node: FigmaNode, acc: Set<string>): void {
  if (node.transitionNodeID) {
    acc.add(node.transitionNodeID);
  }
  for (const reaction of node.reactions ?? []) {
    const dest = reaction.action?.destinationId;
    if (dest) acc.add(dest);
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

/**
 * Considera "tela" cada FRAME/COMPONENT de topo dentro de uma página (CANVAS),
 * inclusive os que estão dentro de SECTIONs de topo.
 */
const SCREEN_TYPES = new Set(["FRAME", "COMPONENT", "COMPONENT_SET"]);

function collectScreensFromPage(
  page: FigmaNode,
  pageName: string,
  screens: DesignScreen[]
): void {
  for (const child of page.children ?? []) {
    if (SCREEN_TYPES.has(child.type)) {
      screens.push(buildScreen(child, pageName));
    } else if (child.type === "SECTION") {
      for (const inner of child.children ?? []) {
        if (SCREEN_TYPES.has(inner.type)) {
          screens.push(buildScreen(inner, `${pageName} › ${child.name}`));
        }
      }
    }
  }
}

function buildScreen(frame: FigmaNode, page: string): DesignScreen {
  const texts: string[] = [];
  collectTexts(frame, texts);

  const transitions = new Set<string>();
  collectTransitions(frame, transitions);

  return {
    id: frame.id,
    name: frame.name,
    page,
    texts: texts.slice(0, MAX_TEXTS_PER_SCREEN),
    transitionsTo: [...transitions],
  };
}

export function parseFigmaDesign(document: FigmaNode): ParsedDesign {
  const screens: DesignScreen[] = [];
  const pages: string[] = [];

  for (const page of document.children ?? []) {
    pages.push(page.name);
    collectScreensFromPage(page, page.name, screens);
  }

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
 * Texto estruturado do protótipo para a IA: páginas, telas, textos visíveis e
 * fluxos de navegação (resolvendo os destinos para nomes de tela).
 */
export function formatDesignAsText(
  document: FigmaNode,
  parsed: ParsedDesign
): string {
  const idToName = new Map<string, string>();
  buildIdNameMap(document, idToName);

  const lines: string[] = [];
  lines.push(
    `# Protótipo Figma — ${parsed.summary.screens} tela(s) em ${parsed.summary.pages} página(s)`
  );
  lines.push("");

  let currentPage = "";
  for (const screen of parsed.screens) {
    if (screen.page !== currentPage) {
      currentPage = screen.page;
      lines.push(`## Página: ${currentPage}`);
      lines.push("");
    }

    lines.push(`### Tela: ${screen.name}`);

    if (screen.texts.length > 0) {
      lines.push(`  Textos: ${screen.texts.join(" | ")}`);
    }

    if (screen.transitionsTo.length > 0) {
      const dests = screen.transitionsTo
        .map((id) => idToName.get(id) ?? id)
        .join(", ");
      lines.push(`  Navega para: ${dests}`);
    }

    lines.push("");
  }

  return lines.join("\n").trim();
}
