export interface FigmaColor {
  r: number;
  g: number;
  b: number;
  a?: number;
}

export interface FigmaPaint {
  type?: string;
  visible?: boolean;
  color?: FigmaColor;
  opacity?: number;
}

export interface FigmaTextStyle {
  fontFamily?: string;
  fontPostScriptName?: string;
  fontSize?: number;
  fontWeight?: number;
  lineHeightPx?: number;
  letterSpacing?: number;
}

export interface FigmaEffect {
  type?: string;
  radius?: number;
  offset?: { x: number; y: number };
  color?: FigmaColor;
  visible?: boolean;
}

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
  fills?: FigmaPaint[];
  strokes?: FigmaPaint[];
  style?: FigmaTextStyle;
  effects?: FigmaEffect[];
  cornerRadius?: number;
  // Campos de prototipagem (presentes em arquivos Figma Design)
  transitionNodeID?: string;
  reactions?: FigmaReaction[];
  children?: FigmaNode[];
}

export interface FigmaReaction {
  action?: {
    type?: string;
    destinationId?: string;
    navigation?: string;
  };
  trigger?: {
    type?: string;
  };
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
  styles?: Record<
    string,
    {
      key?: string;
      name: string;
      styleType?: string;
      description?: string;
    }
  >;
}

export interface FigmaNodesResponse {
  nodes: Record<
    string,
    {
      document: FigmaNode;
    } | null
  >;
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

export interface DesignTransitionDetail {
  destinationId: string;
  trigger?: string;
  action?: string;
}

export interface DesignScreen {
  id: string;
  name: string;
  page: string;
  sectionPath?: string;
  dimensions?: { width: number; height: number };
  texts: string[];
  labels?: string[];
  transitionsTo: string[];
  transitionDetails?: DesignTransitionDetail[];
}

export interface DesignSummary {
  pages: number;
  screens: number;
  textNodes: number;
  flows: number;
  /** Tokens visuais extraídos do Figma (cores, tipografia, etc.). */
  designTokens?: {
    colors: number;
    typography: number;
    effects: number;
    variables: number;
    components: number;
    designSystemFrames: number;
  };
}

export interface ParsedDesignTokenColor {
  name: string;
  hex: string;
  styleId: string;
}

export interface ParsedDesignTokenTypography {
  name: string;
  fontFamily?: string;
  fontSize?: number;
  fontWeight?: number;
  lineHeightPx?: number;
  letterSpacing?: number;
  styleId: string;
}

export interface ParsedDesignTokenEffect {
  name: string;
  description: string;
  styleId: string;
}

export interface ParsedDesignTokenVariable {
  name: string;
  type: string;
  values: string[];
  variableId: string;
  description?: string;
}

export interface ParsedDesignTokenComponent {
  name: string;
  description?: string;
  componentId: string;
  componentSetId?: string;
}

export interface ParsedDesignTokenFrame {
  name: string;
  page: string;
  path: string;
  texts: string[];
}

export interface ParsedDesignTokens {
  colors: ParsedDesignTokenColor[];
  typography: ParsedDesignTokenTypography[];
  effects: ParsedDesignTokenEffect[];
  variables: ParsedDesignTokenVariable[];
  components: ParsedDesignTokenComponent[];
  designSystemFrames: ParsedDesignTokenFrame[];
}

export interface ParsedDesign {
  summary: DesignSummary;
  pages: string[];
  screens: DesignScreen[];
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
  | "pergunta_cliente"
  | "tela_sem_discovery"
  | "discovery_sem_tela"
  | "inconsistencia_proto_discovery";

export type GapSeveridade = "alta" | "media" | "baixa";

export type GapStatus = "aberto" | "resolvido";

export type GapSource = "discovery" | "prototype" | "comparacao";

export interface ActorSummary {
  id: string;
  full_name: string | null;
  email: string | null;
  label: string;
}

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
  source: GapSource;
  resposta?: string;
  figma_reminder_sent_at?: string | null;
  figma_reminder_node_name?: string | null;
  resolved_by?: ActorSummary | null;
  resolved_at?: string | null;
  resposta_by?: ActorSummary | null;
  resposta_at?: string | null;
  figma_reminder_sent_by?: ActorSummary | null;
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
