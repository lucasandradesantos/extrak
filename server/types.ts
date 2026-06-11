export interface FigmaNode {
  id: string;
  name: string;
  type: string;
  characters?: string;
  shapeType?: string;
  connectorStart?: ConnectorEndpoint;
  connectorEnd?: ConnectorEndpoint;
  absoluteBoundingBox?: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  children?: FigmaNode[];
}

export interface ConnectorEndpoint {
  endpointNodeId?: string;
  position?: { x: number; y: number };
  magnet?: string;
}

export interface FigmaFileResponse {
  name: string;
  lastModified: string;
  editorType: string;
  thumbnailUrl: string;
  version: string;
  document: FigmaNode;
  components?: Record<string, unknown>;
  componentSets?: Record<string, unknown>;
  schemaVersion?: number;
  styles?: Record<string, unknown>;
}

export interface FigmaComment {
  id: string;
  message: string;
  created_at: string;
  user: {
    handle: string;
    email?: string;
  };
  client_meta?: {
    node_id?: string;
    node_offset?: { x: number; y: number };
  };
}

export interface FigmaCommentsResponse {
  comments: FigmaComment[];
}

export interface ParsedItem {
  type: string;
  id: string;
  name: string;
  text?: string;
  shapeType?: string;
  path: string[];
  position?: { x: number; y: number };
  connectorStart?: ConnectorEndpoint;
  connectorEnd?: ConnectorEndpoint;
}

export interface ParsedComment {
  id: string;
  message: string;
  user: string;
  created_at: string;
  node_id?: string;
}

export interface ParsedSummary {
  stickies: number;
  shapes: number;
  connectors: number;
  textNodes: number;
  sections: number;
  tables: number;
  widgets: number;
  comments: number;
}

export interface ParsedContent {
  summary: ParsedSummary;
  items: ParsedItem[];
  comments: ParsedComment[];
}

export interface ExportMetadata {
  name: string;
  lastModified: string;
  editorType: string;
  fileKey: string;
  version: string;
}

export interface ExportResponse {
  metadata: ExportMetadata;
  parsed: ParsedContent;
  raw: FigmaFileResponse;
}

export type GapCategoria =
  | "cobertura"
  | "metrica_sem_meta"
  | "persona_faltante"
  | "inconsistencia"
  | "criterio_nao_testavel"
  | "pergunta_cliente";

export type GapSeveridade = "alta" | "media" | "baixa";

export type GapStatus = "aberto" | "resolvido";

export interface Gap {
  id: string;
  chave: string;
  categoria: GapCategoria;
  severidade: GapSeveridade;
  localizacao: string;
  titulo: string;
  descricao: string;
  sugestao: string;
  status: GapStatus;
  resposta?: string;
}

export interface GapDiff {
  resolvidos: string[];
  novos: string[];
  abertos: string[];
}

export interface AnalyzeRequest {
  discovery: string;
  gaps?: Gap[];
  respostas?: Record<string, string>;
}

export interface AnalyzeResponse {
  gaps: Gap[];
  diff?: GapDiff;
}

export interface PrdRequest {
  discovery: string;
  gaps: Gap[];
  respostas?: Record<string, string>;
  boardName?: string;
}

export interface PrdResponse {
  prd: string;
}

export class FigmaApiError extends Error {
  constructor(
    message: string,
    public statusCode: number
  ) {
    super(message);
    this.name = "FigmaApiError";
  }
}

export class ParseUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ParseUrlError";
  }
}
