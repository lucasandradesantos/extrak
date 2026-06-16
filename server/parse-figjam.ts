import {
  FigmaComment,
  FigmaNode,
  ParsedComment,
  ParsedContent,
  ParsedItem,
  ParsedSummary,
} from "./types";

const EXTRACTABLE_TYPES = new Set([
  "STICKY",
  "SHAPE_WITH_TEXT",
  "CONNECTOR",
  "TEXT",
  "SECTION",
  "TABLE",
  "TABLE_CELL",
  "WIDGET",
]);

function getPosition(node: FigmaNode): { x: number; y: number } | undefined {
  const box = node.absoluteBoundingBox;
  if (!box) return undefined;
  return { x: Math.round(box.x), y: Math.round(box.y) };
}

function extractItem(node: FigmaNode, path: string[]): ParsedItem | null {
  if (!EXTRACTABLE_TYPES.has(node.type)) {
    if (node.characters) {
      return {
        type: node.type,
        id: node.id,
        name: node.name,
        text: node.characters,
        path: [...path],
        position: getPosition(node),
      };
    }
    return null;
  }

  const item: ParsedItem = {
    type: node.type,
    id: node.id,
    name: node.name,
    path: [...path],
    position: getPosition(node),
  };

  if (node.characters) {
    item.text = node.characters;
  }

  if (node.shapeType) {
    item.shapeType = node.shapeType;
  }

  if (node.connectorStart) {
    item.connectorStart = node.connectorStart;
  }

  if (node.connectorEnd) {
    item.connectorEnd = node.connectorEnd;
  }

  if (node.type === "SECTION" || node.type === "WIDGET") {
    item.text = node.name;
  }

  return item;
}

function walkNode(
  node: FigmaNode,
  path: string[],
  items: ParsedItem[]
): void {
  const currentPath =
    node.type === "CANVAS" ? [...path, node.name] : path;

  const item = extractItem(node, currentPath);
  if (item) {
    items.push(item);
  }

  const nextPath =
    node.type === "SECTION" ? [...currentPath, node.name] : currentPath;

  for (const child of node.children ?? []) {
    walkNode(child, nextPath, items);
  }
}

function buildSummary(
  items: ParsedItem[],
  comments: ParsedComment[]
): ParsedSummary {
  return {
    stickies: items.filter((i) => i.type === "STICKY").length,
    shapes: items.filter((i) => i.type === "SHAPE_WITH_TEXT").length,
    connectors: items.filter((i) => i.type === "CONNECTOR").length,
    textNodes: items.filter((i) => i.type === "TEXT").length,
    sections: items.filter((i) => i.type === "SECTION").length,
    tables: items.filter(
      (i) => i.type === "TABLE" || i.type === "TABLE_CELL"
    ).length,
    widgets: items.filter((i) => i.type === "WIDGET").length,
    comments: comments.length,
  };
}

function parseComments(comments: FigmaComment[]): ParsedComment[] {
  return comments.map((comment) => ({
    id: comment.id,
    message: comment.message,
    user: comment.user.handle,
    created_at: comment.created_at,
    node_id: comment.client_meta?.node_id,
  }));
}

export function parseFigJamDocument(
  document: FigmaNode,
  comments: FigmaComment[] = []
): ParsedContent {
  const items: ParsedItem[] = [];

  for (const page of document.children ?? []) {
    walkNode(page, [], items);
  }

  const parsedComments = parseComments(comments);

  return {
    summary: buildSummary(items, parsedComments),
    items,
    comments: parsedComments,
  };
}

const MEANINGFUL_TEXT_TYPES = new Set([
  "STICKY",
  "SHAPE_WITH_TEXT",
  "TEXT",
  "TABLE_CELL",
  "WIDGET",
  "CONNECTOR",
]);

/**
 * Versão enxuta do Discovery para a IA: agrupa por seção (path) e mostra só o
 * texto relevante, sem IDs nem posições, para economizar tokens.
 */
export function buildDiscoveryText(parsed: ParsedContent, title?: string): string {
  const lines: string[] = [];
  if (title) {
    lines.push(`# Discovery: ${title}`);
    lines.push("");
  }

  const grouped = new Map<string, string[]>();
  for (const item of parsed.items) {
    const text = item.text?.trim();
    if (!text) continue;
    if (!MEANINGFUL_TEXT_TYPES.has(item.type) && item.type !== "SECTION") {
      continue;
    }
    const key = item.path.length > 0 ? item.path.join(" > ") : "(sem seção)";
    const list = grouped.get(key) ?? [];
    list.push(text.replace(/\s+/g, " ").trim());
    grouped.set(key, list);
  }

  for (const [section, texts] of grouped) {
    lines.push(`## ${section}`);
    for (const text of texts) {
      lines.push(`- ${text}`);
    }
    lines.push("");
  }

  if (parsed.comments.length > 0) {
    lines.push("## Comentários");
    for (const comment of parsed.comments) {
      lines.push(`- ${comment.user}: ${comment.message.replace(/\s+/g, " ").trim()}`);
    }
    lines.push("");
  }

  return lines.join("\n").trim();
}

export function formatParsedAsText(parsed: ParsedContent): string {
  const lines: string[] = [];

  const grouped = new Map<string, ParsedItem[]>();
  for (const item of parsed.items) {
    const list = grouped.get(item.type) ?? [];
    list.push(item);
    grouped.set(item.type, list);
  }

  const typeLabels: Record<string, string> = {
    STICKY: "Sticky Notes",
    SHAPE_WITH_TEXT: "Shapes com Texto",
    CONNECTOR: "Conectores",
    TEXT: "Textos",
    SECTION: "Seções",
    TABLE: "Tabelas",
    TABLE_CELL: "Células de Tabela",
    WIDGET: "Widgets",
  };

  for (const [type, items] of grouped) {
    lines.push(`## ${typeLabels[type] ?? type} (${items.length})`);
    lines.push("");

    for (const item of items) {
      const location =
        item.path.length > 0 ? ` [${item.path.join(" > ")}]` : "";
      lines.push(`- **${item.name}** (${item.id})${location}`);

      if (item.text) {
        lines.push(`  ${item.text.replace(/\n/g, "\n  ")}`);
      }

      if (item.shapeType) {
        lines.push(`  Shape: ${item.shapeType}`);
      }

      if (item.connectorStart || item.connectorEnd) {
        const start = item.connectorStart?.endpointNodeId ?? "—";
        const end = item.connectorEnd?.endpointNodeId ?? "—";
        lines.push(`  Conexão: ${start} → ${end}`);
      }

      lines.push("");
    }
  }

  if (parsed.comments.length > 0) {
    lines.push(`## Comentários (${parsed.comments.length})`);
    lines.push("");

    for (const comment of parsed.comments) {
      lines.push(
        `- **${comment.user}** (${new Date(comment.created_at).toLocaleString("pt-BR")})`
      );
      lines.push(`  ${comment.message.replace(/\n/g, "\n  ")}`);
      lines.push("");
    }
  }

  return lines.join("\n").trim();
}
