export interface ParsedItem {
  type: string;
  id: string;
  name: string;
  text?: string;
  shapeType?: string;
  path: string[];
  position?: { x: number; y: number };
  connectorStart?: {
    endpointNodeId?: string;
  };
  connectorEnd?: {
    endpointNodeId?: string;
  };
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

export interface ExportResponse {
  metadata: {
    name: string;
    lastModified: string;
    editorType: string;
    fileKey: string;
    version: string;
  };
  parsed: {
    summary: ParsedSummary;
    items: ParsedItem[];
    comments: ParsedComment[];
  };
  raw: unknown;
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

export interface AnalyzeResponse {
  gaps: Gap[];
  diff?: GapDiff;
}

export interface PrdResponse {
  prd: string;
}
