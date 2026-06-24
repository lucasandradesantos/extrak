export type UserRole = "super_admin" | "team_admin" | "member";

export interface Profile {
  id: string;
  full_name: string | null;
  team_id: string | null;
  role: UserRole;
}

export interface Team {
  id: string;
  name: string;
  created_at: string;
}

export interface AdminUser {
  id: string;
  full_name: string | null;
  team_id: string | null;
  role: UserRole;
  email: string | null;
  created_at: string;
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

export interface ProjectSummary {
  id: string;
  name: string;
  team_id: string;
  status: string;
  discovery_url: string | null;
  prototype_url: string | null;
  discovery_file_key?: string | null;
  prototype_file_key?: string | null;
  created_at: string;
  updated_at: string;
  created_by?: ActorSummary | null;
  analysis_status?: "pending" | "running" | "done" | "error" | null;
  analysis_progress?: { processed: number; total: number } | null;
}

export interface FigmaPreviewImage {
  id: string;
  name: string;
  page: string;
  url: string | null;
}

export interface FigmaPreviewResult {
  fileName: string;
  images: FigmaPreviewImage[];
}

export interface SourceSummaryDesignTokens {
  colors: number;
  typography: number;
  effects: number;
  variables: number;
  components: number;
  designSystemFrames: number;
}

export interface SourceMetadata {
  name?: string;
  editorType?: string;
  version?: string;
  lastModified?: string;
  summary?: Record<string, number | SourceSummaryDesignTokens>;
}

export interface ProjectSource {
  kind: "discovery" | "prototype";
  figma_file_key: string;
  metadata: SourceMetadata | null;
  discovery_text: string | null;
  created_at: string;
}

export interface AnalysisJob {
  id: string;
  status: "pending" | "running" | "done" | "error";
  total_chunks: number;
  processed_chunks: number;
  error: string | null;
}

export interface AnalysisRow {
  id: string;
  round: number;
  status: string;
  created_by?: ActorSummary | null;
}

export interface ProjectDetail {
  project: ProjectSummary;
  sources: ProjectSource[];
  analysis: AnalysisRow | null;
  gaps: Gap[];
  job: AnalysisJob | null;
  prd: { id: string; version: number; content_md: string } | null;
}

export interface StepResponse {
  status: "running" | "done";
  processed: number;
  total: number;
  gaps?: Gap[];
}

export type SpecDocKind =
  | "requirements"
  | "architecture"
  | "data_model"
  | "design_system"
  | "implementation_plan"
  | "business_model"
  | "agents"
  | "open_questions"
  | "qa_test_cases";

export interface SpecDoc {
  kind: SpecDocKind;
  label: string;
  filename: string;
  content_md: string | null;
  version: number;
  updated_at: string | null;
  qa_validation?: { complete: boolean; issues: string[] };
}

export interface AnalysisSourceMetadata {
  discovery?: SourceMetadata | null;
  prototype?: SourceMetadata | null;
}

export interface AnalysisHistoryItem {
  id: string;
  round: number;
  status: string;
  created_at: string;
  source_metadata: AnalysisSourceMetadata | null;
  created_by?: ActorSummary | null;
  total: number;
  counts: { alta: number; media: number; baixa: number };
}

export interface AnalysisCompareRound {
  id: string;
  round: number;
  created_at: string;
  source_metadata: AnalysisSourceMetadata | null;
  created_by?: ActorSummary | null;
}

export interface AnalysisCompareResult {
  from: AnalysisCompareRound;
  to: AnalysisCompareRound;
  resolved: Gap[];
  new: Gap[];
  persistent: Gap[];
}
