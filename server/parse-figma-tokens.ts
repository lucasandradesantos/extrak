import {
  FigmaFileResponse,
  FigmaNode,
  FigmaNodesResponse,
  ParsedDesignTokens,
} from "./types";

const DS_PAGE_PATTERNS = [
  /design\s*system/i,
  /^tokens$/i,
  /^foundations?$/i,
  /^colors?$/i,
  /^typography$/i,
  /^type\s*scale$/i,
  /^spacing$/i,
  /^components?\s*(library|lib)?$/i,
  /biblioteca\s*(de\s*)?componentes/i,
  /^estilos?$/i,
  /^styles?$/i,
];

const DS_SECTION_PATTERNS = [
  ...DS_PAGE_PATTERNS,
  /color\s*palette/i,
  /paleta\s*(de\s*)?cores/i,
  /grid\s*system/i,
];

const TOKEN_MARKERS = {
  start: "<!-- EXTRAK_DESIGN_TOKENS_START -->",
  end: "<!-- EXTRAK_DESIGN_TOKENS_END -->",
};

function rgbToHex(r: number, g: number, b: number): string {
  const hex = (n: number) =>
    Math.round(Math.max(0, Math.min(1, n)) * 255)
      .toString(16)
      .padStart(2, "0");
  return `#${hex(r)}${hex(g)}${hex(b)}`.toUpperCase();
}

function paintToHex(paint: { color?: { r: number; g: number; b: number; a?: number } }): string | null {
  const c = paint.color;
  if (!c) return null;
  const hex = rgbToHex(c.r, c.g, c.b);
  if (c.a != null && c.a < 1) {
    return `${hex} (${Math.round(c.a * 100)}% opacidade)`;
  }
  return hex;
}

function primaryFillHex(node: FigmaNode): string | null {
  for (const fill of node.fills ?? []) {
    if (fill.visible === false || fill.type !== "SOLID") continue;
    const hex = paintToHex(fill);
    if (hex) return hex;
  }
  return null;
}

function isDesignSystemLabel(name: string): boolean {
  const trimmed = name.trim();
  return (
    DS_PAGE_PATTERNS.some((re) => re.test(trimmed)) ||
    DS_SECTION_PATTERNS.some((re) => re.test(trimmed))
  );
}

function collectDesignSystemTexts(node: FigmaNode, acc: string[]): void {
  if (node.type === "TEXT" && node.characters?.trim()) {
    acc.push(node.characters.replace(/\s+/g, " ").trim());
  }
  for (const child of node.children ?? []) {
    collectDesignSystemTexts(child, acc);
  }
}

/** Identifica páginas/seções de Design System no arquivo Figma. */
export function collectDesignSystemFrames(
  document: FigmaNode
): Array<{ name: string; page: string; path: string; texts: string[] }> {
  const frames: Array<{ name: string; page: string; path: string; texts: string[] }> = [];

  function maybeAddFrame(
    node: FigmaNode,
    pageName: string,
    path: string
  ): void {
    if (node.type !== "FRAME" && node.type !== "SECTION" && node.type !== "COMPONENT") {
      return;
    }
    const texts: string[] = [];
    collectDesignSystemTexts(node, texts);
    if (texts.length === 0 && node.type === "SECTION") return;
    frames.push({
      name: node.name,
      page: pageName,
      path: path || node.name,
      texts: [...new Set(texts)].slice(0, 80),
    });
  }

  function walk(
    node: FigmaNode,
    pageName: string,
    sectionPath: string,
    inDsContext: boolean
  ): void {
    const isDs =
      inDsContext || isDesignSystemLabel(node.name) || isDesignSystemLabel(pageName);

    if (isDs && (node.type === "FRAME" || node.type === "COMPONENT")) {
      const box = node.absoluteBoundingBox;
      if (box && box.width >= 100 && box.height >= 80) {
        maybeAddFrame(node, pageName, sectionPath);
      }
    }

    let nextPath = sectionPath;
    if (node.type === "SECTION") {
      nextPath = sectionPath ? `${sectionPath} › ${node.name}` : node.name;
    }

    for (const child of node.children ?? []) {
      walk(child, pageName, nextPath, isDs);
    }
  }

  for (const page of document.children ?? []) {
    if (page.type !== "CANVAS") continue;
    const pageIsDs = isDesignSystemLabel(page.name);
    for (const child of page.children ?? []) {
      walk(child, page.name, "", pageIsDs);
    }
  }

  return frames.slice(0, 40);
}

export function parseStyleNodes(
  file: FigmaFileResponse,
  nodes: FigmaNodesResponse["nodes"]
): Pick<ParsedDesignTokens, "colors" | "typography" | "effects"> {
  const colors: ParsedDesignTokens["colors"] = [];
  const typography: ParsedDesignTokens["typography"] = [];
  const effects: ParsedDesignTokens["effects"] = [];

  for (const [styleId, meta] of Object.entries(file.styles ?? {})) {
    const node = nodes[styleId]?.document;
    if (!node) continue;

    const styleType = meta.styleType ?? "UNKNOWN";

    if (styleType === "FILL") {
      const hex = primaryFillHex(node);
      if (hex) {
        colors.push({ name: meta.name, hex, styleId });
      }
    }

    if (styleType === "TEXT") {
      const s = node.style;
      typography.push({
        name: meta.name,
        fontFamily: s?.fontFamily,
        fontSize: s?.fontSize,
        fontWeight: s?.fontWeight,
        lineHeightPx: s?.lineHeightPx,
        letterSpacing: s?.letterSpacing,
        styleId,
      });
    }

    if (styleType === "EFFECT" && node.effects?.length) {
      for (const effect of node.effects) {
        if (effect.type !== "DROP_SHADOW" && effect.type !== "INNER_SHADOW") continue;
        const parts: string[] = [effect.type];
        if (effect.radius != null) parts.push(`blur ${effect.radius}px`);
        if (effect.offset) {
          parts.push(`offset ${effect.offset.x}px ${effect.offset.y}px`);
        }
        if (effect.color) {
          const hex = paintToHex({ color: effect.color });
          if (hex) parts.push(hex);
        }
        effects.push({ name: meta.name, description: parts.join(", "), styleId });
      }
    }
  }

  colors.sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));
  typography.sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));
  effects.sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));

  return { colors, typography, effects };
}

export function parseComponents(file: FigmaFileResponse): ParsedDesignTokens["components"] {
  const components: ParsedDesignTokens["components"] = [];

  for (const [id, comp] of Object.entries(file.components ?? {})) {
    const c = comp as { name?: string; description?: string; componentSetId?: string };
    if (!c.name?.trim()) continue;
    components.push({
      name: c.name.trim(),
      description: c.description?.trim() || undefined,
      componentId: id,
      componentSetId: c.componentSetId,
    });
  }

  components.sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));
  return components;
}

export interface FigmaVariablesLocal {
  variables?: Record<
    string,
    {
      name: string;
      resolvedType: string;
      variableCollectionId?: string;
      valuesByMode?: Record<string, unknown>;
      description?: string;
    }
  >;
  variableCollections?: Record<
    string,
    {
      name: string;
      modes?: Array<{ modeId: string; name: string }>;
    }
  >;
}

function formatVariableValue(value: unknown): string {
  if (value == null) return "—";
  if (typeof value === "number") return String(value);
  if (typeof value === "string") return value;
  if (typeof value === "object" && value !== null && "r" in value) {
    const c = value as { r: number; g: number; b: number; a?: number };
    return rgbToHex(c.r, c.g, c.b);
  }
  return JSON.stringify(value);
}

export function parseVariables(
  data: FigmaVariablesLocal | null
): ParsedDesignTokens["variables"] {
  if (!data?.variables) return [];

  const collections = data.variableCollections ?? {};
  const variables: ParsedDesignTokens["variables"] = [];

  for (const [id, variable] of Object.entries(data.variables)) {
    const coll = collections[variable.variableCollectionId ?? ""];
    const modes = Object.entries(variable.valuesByMode ?? {});
    const values = modes.map(([modeId, val]) => {
      const modeName =
        coll?.modes?.find((m) => m.modeId === modeId)?.name ?? modeId;
      return `${modeName}: ${formatVariableValue(val)}`;
    });

    variables.push({
      name: variable.name,
      type: variable.resolvedType,
      values: values.length > 0 ? values : ["—"],
      variableId: id,
      description: variable.description,
    });
  }

  variables.sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));
  return variables;
}

export function formatDesignTokensAsText(tokens: ParsedDesignTokens): string {
  const lines: string[] = [];
  lines.push(TOKEN_MARKERS.start);
  lines.push("# Tokens e estilos extraídos do Figma");
  lines.push("");
  lines.push(
    `Resumo: ${tokens.colors.length} cor(es), ${tokens.typography.length} estilo(s) tipográfico(s), ${tokens.effects.length} efeito(s), ${tokens.variables.length} variável(is), ${tokens.components.length} componente(s) publicado(s), ${tokens.designSystemFrames.length} frame(s) em páginas de Design System.`
  );
  lines.push("");

  if (tokens.colors.length > 0) {
    lines.push("## Cores (estilos FILL)");
    for (const color of tokens.colors) {
      lines.push(`- **${color.name}:** \`${color.hex}\``);
    }
    lines.push("");
  }

  if (tokens.typography.length > 0) {
    lines.push("## Tipografia (estilos TEXT)");
    for (const t of tokens.typography) {
      const parts = [t.name];
      const specs: string[] = [];
      if (t.fontFamily) specs.push(`fonte ${t.fontFamily}`);
      if (t.fontSize != null) specs.push(`${t.fontSize}px`);
      if (t.fontWeight != null) specs.push(`peso ${t.fontWeight}`);
      if (t.lineHeightPx != null) specs.push(`line-height ${t.lineHeightPx}px`);
      if (t.letterSpacing != null) specs.push(`letter-spacing ${t.letterSpacing}`);
      if (specs.length > 0) parts.push(`(${specs.join(", ")})`);
      lines.push(`- ${parts.join(" ")}`);
    }
    lines.push("");
  }

  if (tokens.effects.length > 0) {
    lines.push("## Efeitos (sombras e elevação)");
    for (const e of tokens.effects) {
      lines.push(`- **${e.name}:** ${e.description}`);
    }
    lines.push("");
  }

  if (tokens.variables.length > 0) {
    lines.push("## Variáveis Figma");
    for (const v of tokens.variables) {
      lines.push(`- **${v.name}** (${v.type}): ${v.values.join(" | ")}`);
      if (v.description) lines.push(`  - ${v.description}`);
    }
    lines.push("");
  }

  if (tokens.components.length > 0) {
    lines.push("## Componentes publicados no arquivo");
    for (const c of tokens.components) {
      lines.push(
        `- **${c.name}**${c.description ? `: ${c.description}` : ""}`
      );
    }
    lines.push("");
  }

  if (tokens.designSystemFrames.length > 0) {
    lines.push("## Conteúdo de páginas/seções de Design System");
    for (const frame of tokens.designSystemFrames) {
      lines.push(`### ${frame.name} (${frame.page}${frame.path ? ` › ${frame.path}` : ""})`);
      if (frame.texts.length > 0) {
        lines.push("Textos:");
        for (const text of frame.texts.slice(0, 30)) {
          lines.push(`- ${text}`);
        }
        if (frame.texts.length > 30) {
          lines.push(`- ... +${frame.texts.length - 30} texto(s)`);
        }
      }
      lines.push("");
    }
  }

  if (
    tokens.colors.length === 0 &&
    tokens.typography.length === 0 &&
    tokens.variables.length === 0
  ) {
    lines.push(
      "_Nenhum estilo ou variável encontrado automaticamente. Verifique se o arquivo Figma possui estilos locais ou variables publicadas._"
    );
    lines.push("");
  }

  lines.push(TOKEN_MARKERS.end);
  return lines.join("\n").trim();
}

/** Extrai a seção de tokens do texto completo do protótipo. */
export function extractDesignTokensSection(prototypeText: string): string | null {
  const start = prototypeText.indexOf(TOKEN_MARKERS.start);
  const end = prototypeText.indexOf(TOKEN_MARKERS.end);
  if (start === -1 || end === -1 || end <= start) return null;
  return prototypeText.slice(start, end + TOKEN_MARKERS.end.length).trim();
}

/** Remove a seção de tokens do texto de wireframes (evita duplicar nos passos de IA). */
export function stripDesignTokensSection(prototypeText: string): string {
  const start = prototypeText.indexOf(TOKEN_MARKERS.start);
  if (start === -1) return prototypeText;
  const end = prototypeText.indexOf(TOKEN_MARKERS.end);
  if (end === -1) return prototypeText.slice(0, start).trim();
  return (prototypeText.slice(0, start) + prototypeText.slice(end + TOKEN_MARKERS.end.length))
    .trim()
    .replace(/\n{3,}/g, "\n\n");
}

export function buildParsedDesignTokens(
  file: FigmaFileResponse,
  styleNodes: FigmaNodesResponse["nodes"],
  variablesData: FigmaVariablesLocal | null
): ParsedDesignTokens {
  const fromStyles = parseStyleNodes(file, styleNodes);
  return {
    ...fromStyles,
    variables: parseVariables(variablesData),
    components: parseComponents(file),
    designSystemFrames: collectDesignSystemFrames(file.document),
  };
}
