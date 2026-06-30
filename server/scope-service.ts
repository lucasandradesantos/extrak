import { randomUUID } from "node:crypto";
import { completeJson } from "./anthropic-client";
import { SCOPE_SYSTEM, buildScopeChunkPrompt } from "./prompts";
import { chunkDiscovery, MAX_FULL_DISCOVERY_CHARS, truncate } from "./analysis-service";
import { getSetting, setSetting } from "./settings";
import { getSupabaseAdmin } from "./supabase";

const SCOPE_STEP_DEADLINE_MS = 52_000;
const SCOPE_MAX_TOKENS = 6_144;
/** Chunks enxutos → cada passo de mapeamento termina antes do timeout serverless. */
const SCOPE_CHUNK_CHARS = 10_000;

export const SCOPE_CONFIG_SETTING = "scope_config";

export type ScopePlatform = "web" | "mobile_native" | "mobile_responsive";
export type ScopeComplexity = "simples" | "media" | "dificil";
export type ScopeConfidence = "low" | "medium" | "high";
/** Modelo comercial — define quem assume o risco do estouro de prazo. */
export type ScopeSalesModel = "fechado" | "banco_horas";

export interface FeatureHours {
  product: number;
  development: number;
  qa: number;
  total: number;
}

export interface ScopeConfig {
  hourly_rate: number;
  platform_multipliers: Record<ScopePlatform, number>;
  buffers: { qa: number; product: number };
  /** Horas-base por nível de complexidade (faixas do PRD §4.3). */
  complexity_ranges: Record<ScopeComplexity, number>;
  phases: string[];
}

export interface ScopeFeature {
  id: string;
  title: string;
  description: string;
  platforms: ScopePlatform[];
  phase: string;
  complexity: ScopeComplexity;
  lowcode_factor: number;
  origin_frames: string[];
  confidence: ScopeConfidence;
  is_active: boolean;
  hours: FeatureHours;
}

export interface ScopeModule {
  id: string;
  name: string;
  category: string;
  description_client: string;
  is_mandatory: boolean;
  mandatory_reason: string;
  features: ScopeFeature[];
}

export interface ScopeData {
  modules: ScopeModule[];
  generated_at?: string;
  /** Modelo comercial escolhido na geração. */
  sales_model?: ScopeSalesModel;
  /** Margem de erro/risco aplicada às horas (fração, ex.: 0.2 = 20%). */
  risk_margin?: number;
}

/** Garante a margem num intervalo seguro (0–100%). */
export function clampRiskMargin(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

export const DEFAULT_SCOPE_CONFIG: ScopeConfig = {
  hourly_rate: 150,
  platform_multipliers: { web: 1.0, mobile_native: 1.4, mobile_responsive: 1.1 },
  buffers: { qa: 0.15, product: 0.1 },
  complexity_ranges: { simples: 4, media: 10, dificil: 26 },
  phases: ["MVP", "V2", "V3"],
};

// --- Configuração global -----------------------------------------------------

function mergeConfig(partial: Partial<ScopeConfig> | null): ScopeConfig {
  if (!partial) return DEFAULT_SCOPE_CONFIG;
  return {
    hourly_rate: partial.hourly_rate ?? DEFAULT_SCOPE_CONFIG.hourly_rate,
    platform_multipliers: {
      ...DEFAULT_SCOPE_CONFIG.platform_multipliers,
      ...(partial.platform_multipliers ?? {}),
    },
    buffers: { ...DEFAULT_SCOPE_CONFIG.buffers, ...(partial.buffers ?? {}) },
    complexity_ranges: {
      ...DEFAULT_SCOPE_CONFIG.complexity_ranges,
      ...(partial.complexity_ranges ?? {}),
    },
    phases:
      Array.isArray(partial.phases) && partial.phases.length > 0
        ? partial.phases
        : DEFAULT_SCOPE_CONFIG.phases,
  };
}

export async function getScopeConfig(): Promise<ScopeConfig> {
  const raw = await getSetting(SCOPE_CONFIG_SETTING);
  if (!raw) return DEFAULT_SCOPE_CONFIG;
  try {
    return mergeConfig(JSON.parse(raw) as Partial<ScopeConfig>);
  } catch {
    return DEFAULT_SCOPE_CONFIG;
  }
}

export async function saveScopeConfig(
  config: Partial<ScopeConfig>,
  updatedBy?: string | null
): Promise<ScopeConfig> {
  const merged = mergeConfig(config);
  await setSetting(SCOPE_CONFIG_SETTING, JSON.stringify(merged), updatedBy);
  return merged;
}

// --- Cálculo de horas (determinístico) ---------------------------------------

const COMPLEXITY_BY_WEIGHT: Record<number, ScopeComplexity> = {
  1: "simples",
  2: "media",
  3: "dificil",
};

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/**
 * Calcula as horas de UMA feature (Produto/Dev/QA) a partir da complexidade,
 * do fator low-code e dos multiplicadores de plataforma. Fórmula do PRD §4.3.
 * A margem de risco (escopo fechado/banco de horas) infla P/D/QA por (1+margem).
 * Piso de 1h para features ativas; features inativas zeram.
 */
export function computeFeatureHours(
  feature: Pick<ScopeFeature, "platforms" | "complexity" | "lowcode_factor" | "is_active">,
  config: ScopeConfig,
  riskMargin = 0
): FeatureHours {
  const zero: FeatureHours = { product: 0, development: 0, qa: 0, total: 0 };
  if (!feature.is_active) return zero;

  const base = config.complexity_ranges[feature.complexity] ?? config.complexity_ranges.media;
  const lowcode = feature.lowcode_factor || 1;
  const platforms = feature.platforms.length > 0 ? feature.platforms : ["web" as const];
  const margin = 1 + clampRiskMargin(riskMargin);

  let development = 0;
  for (const platform of platforms) {
    const multiplier = config.platform_multipliers[platform] ?? 1;
    development += base * lowcode * multiplier;
  }
  development *= margin;

  let qa = development * config.buffers.qa;
  let product = development * config.buffers.product;
  let total = development + qa + product;

  // Piso de 1h numa feature ativa.
  if (total < 1) {
    development = 1;
    qa = 0;
    product = 0;
    total = 1;
  }

  return {
    product: round1(product),
    development: round1(development),
    qa: round1(qa),
    total: round1(total),
  };
}

// --- Normalização da saída da IA ---------------------------------------------

const PLATFORMS: ScopePlatform[] = ["web", "mobile_native", "mobile_responsive"];

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function asPlatforms(value: unknown): ScopePlatform[] {
  if (!Array.isArray(value)) return ["web"];
  const out = value.filter((v): v is ScopePlatform =>
    PLATFORMS.includes(v as ScopePlatform)
  );
  return out.length > 0 ? Array.from(new Set(out)) : ["web"];
}

function asComplexity(value: unknown): ScopeComplexity {
  const n = Number(value);
  if (n === 1 || n === 2 || n === 3) return COMPLEXITY_BY_WEIGHT[n];
  if (value === "simples" || value === "media" || value === "dificil") return value;
  return "media";
}

function asLowcode(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0.7;
  return Math.min(1, Math.max(0.4, n));
}

function asConfidence(value: unknown): ScopeConfidence {
  return value === "low" || value === "medium" || value === "high" ? value : "medium";
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((v) => asString(v)).filter(Boolean);
}

/** Converte a saída crua da IA em módulos válidos (sem calcular horas ainda). */
export function normalizeScopeModules(raw: unknown, config: ScopeConfig): ScopeModule[] {
  const list = Array.isArray(raw) ? raw : [];
  const modules: ScopeModule[] = [];

  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const m = item as Record<string, unknown>;
    const name = asString(m.name).trim();
    if (!name) continue;

    const rawFeatures = Array.isArray(m.features) ? m.features : [];
    const features: ScopeFeature[] = [];

    for (const f of rawFeatures) {
      if (!f || typeof f !== "object") continue;
      const fr = f as Record<string, unknown>;
      const title = asString(fr.title).trim();
      const origin = asStringArray(fr.origin_frames);
      // Regra anti-alucinação: descarta features sem rastreabilidade.
      if (!title || origin.length === 0) continue;

      const base: Omit<ScopeFeature, "hours"> = {
        id: randomUUID(),
        title,
        description: asString(fr.description),
        platforms: asPlatforms(fr.platforms),
        phase: asString(fr.suggested_phase ?? fr.phase, "MVP"),
        complexity: asComplexity(fr.complexity_weight ?? fr.complexity),
        lowcode_factor: asLowcode(fr.lowcode_factor),
        origin_frames: origin,
        confidence: asConfidence(fr.confidence),
        is_active: true,
      };
      features.push({ ...base, hours: computeFeatureHours(base, config) });
    }

    modules.push({
      id: randomUUID(),
      name,
      category: asString(m.category, "Geral"),
      description_client: asString(m.description_client),
      is_mandatory: Boolean(m.is_mandatory),
      mandatory_reason: asString(m.mandatory_reason),
      features,
    });
  }

  return modules;
}

/** Mescla módulos repetidos entre chunks (por nome normalizado), unindo features. */
export function mergeModules(modules: ScopeModule[]): ScopeModule[] {
  const byKey = new Map<string, ScopeModule>();

  for (const mod of modules) {
    const key = mod.name.trim().toLowerCase();
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, { ...mod, features: [...mod.features] });
      continue;
    }
    existing.is_mandatory = existing.is_mandatory || mod.is_mandatory;
    if (!existing.description_client && mod.description_client) {
      existing.description_client = mod.description_client;
    }
    const seen = new Set(existing.features.map((f) => f.title.trim().toLowerCase()));
    for (const feature of mod.features) {
      const fkey = feature.title.trim().toLowerCase();
      if (!seen.has(fkey)) {
        seen.add(fkey);
        existing.features.push(feature);
      }
    }
  }

  return Array.from(byKey.values());
}

/** Consolida os módulos crus acumulados e recalcula todas as horas. */
export function assembleScope(
  rawModules: ScopeModule[],
  config: ScopeConfig,
  options: { riskMargin?: number; salesModel?: ScopeSalesModel } = {}
): ScopeData {
  const riskMargin = clampRiskMargin(options.riskMargin ?? 0);
  const merged = mergeModules(rawModules).map((mod) => ({
    ...mod,
    features: mod.features.map((f) => ({
      ...f,
      hours: computeFeatureHours(f, config, riskMargin),
    })),
  }));
  return { modules: merged, sales_model: options.salesModel, risk_margin: riskMargin };
}

// --- Planejamento dos passos -------------------------------------------------

export interface ScopeStepPlan {
  id: string;
  label: string;
  /** Passo gerado por código (consolidação), sem chamada à IA. */
  deterministic?: boolean;
}

export function planScopeSteps(rawDiscovery: string): ScopeStepPlan[] {
  const discovery = truncate(rawDiscovery, MAX_FULL_DISCOVERY_CHARS);
  const chunks = chunkDiscovery(discovery, SCOPE_CHUNK_CHARS);
  const steps: ScopeStepPlan[] = chunks.map((_chunk, index) => ({
    id: `chunk-${index}`,
    label:
      chunks.length > 1
        ? `Mapeando módulos (${index + 1}/${chunks.length})`
        : "Mapeando módulos",
  }));
  steps.push({ id: "finalize", label: "Consolidando escopo e horas", deterministic: true });
  return steps;
}

// --- Rascunho persistido (acumulação entre passos) ---------------------------

export async function loadScopeDraft(projectId: string): Promise<ScopeModule[]> {
  const admin = getSupabaseAdmin();
  const { data } = await admin
    .from("project_docs")
    .select("content_md")
    .eq("project_id", projectId)
    .eq("kind", "scope_draft")
    .order("version", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!data?.content_md) return [];
  try {
    const parsed = JSON.parse(data.content_md);
    return Array.isArray(parsed) ? (parsed as ScopeModule[]) : [];
  } catch {
    return [];
  }
}

/**
 * Upsert manual de um project_docs por (project_id, kind). NÃO usa
 * onConflict — project_docs não tem constraint única em (project_id, kind)
 * (usa versionamento), então onConflict falha com 42P10. Aqui fazemos
 * select → update/insert e CHECAMOS o erro (lança em falha), para que uma
 * falha de gravação vire erro do job em vez de um "done" silencioso.
 */
async function upsertProjectDoc(
  projectId: string,
  kind: string,
  contentMd: string
): Promise<void> {
  const admin = getSupabaseAdmin();
  const { data: existing, error: selError } = await admin
    .from("project_docs")
    .select("id")
    .eq("project_id", projectId)
    .eq("kind", kind)
    .order("version", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (selError) {
    throw new Error(`Falha ao ler ${kind}: ${selError.message}`);
  }

  if (existing?.id) {
    const { error } = await admin
      .from("project_docs")
      .update({ content_md: contentMd, updated_at: new Date().toISOString() })
      .eq("id", existing.id);
    if (error) throw new Error(`Falha ao atualizar ${kind}: ${error.message}`);
    return;
  }

  const { error } = await admin
    .from("project_docs")
    .insert({ project_id: projectId, kind, content_md: contentMd, version: 1 });
  if (error) throw new Error(`Falha ao inserir ${kind}: ${error.message}`);
}

export async function saveScopeDraft(
  projectId: string,
  modules: ScopeModule[]
): Promise<void> {
  await upsertProjectDoc(projectId, "scope_draft", JSON.stringify(modules));
}

export async function clearScopeDraft(projectId: string): Promise<void> {
  const admin = getSupabaseAdmin();
  await admin
    .from("project_docs")
    .delete()
    .eq("project_id", projectId)
    .eq("kind", "scope_draft");
}

export async function loadScope(projectId: string): Promise<ScopeData | null> {
  const admin = getSupabaseAdmin();
  const { data } = await admin
    .from("project_docs")
    .select("content_md")
    .eq("project_id", projectId)
    .eq("kind", "scope")
    .order("version", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!data?.content_md) return null;
  try {
    return JSON.parse(data.content_md) as ScopeData;
  } catch {
    return null;
  }
}

export async function saveScope(projectId: string, scope: ScopeData): Promise<void> {
  await upsertProjectDoc(projectId, "scope", JSON.stringify(scope));
}

// --- Geração de um passo (chunk) ---------------------------------------------

export interface ScopeGenParams {
  discovery: string;
  productName?: string;
  salesModel?: ScopeSalesModel;
}

/** Gera os módulos de UM chunk do Discovery via IA. */
export async function generateScopeStep(
  params: ScopeGenParams,
  stepId: string,
  accumulated: ScopeModule[],
  config: ScopeConfig
): Promise<ScopeModule[]> {
  const discovery = truncate(params.discovery, MAX_FULL_DISCOVERY_CHARS);
  const chunks = chunkDiscovery(discovery, SCOPE_CHUNK_CHARS);
  const index = stepId.startsWith("chunk-")
    ? Number(stepId.replace("chunk-", ""))
    : -1;

  if (index < 0 || index >= chunks.length) {
    throw new Error(`Passo de escopo desconhecido: ${stepId}`);
  }

  const prompt = buildScopeChunkPrompt({
    discovery: chunks[index],
    productName: params.productName,
    salesModel: params.salesModel,
    chunkIndex: index,
    chunkTotal: chunks.length,
    previousModuleNames: Array.from(new Set(accumulated.map((m) => m.name))),
  });

  const raw = await completeJson<unknown>({
    system: SCOPE_SYSTEM,
    prompt,
    maxTokens: SCOPE_MAX_TOKENS,
    deadlineMs: SCOPE_STEP_DEADLINE_MS,
  });

  return normalizeScopeModules(raw, config);
}
