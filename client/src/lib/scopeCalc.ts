import type {
  FeatureHours,
  ScopeComplexity,
  ScopeConfig,
  ScopeData,
  ScopeFeature,
  ScopeModule,
  ScopePlatform,
} from "../types";

// Espelha server/scope-service.ts:computeFeatureHours para recálculo em tempo
// real no cliente (sem nova chamada de IA). Manter as duas em sincronia.

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

// Pisos realistas por feature ativa (espelha o servidor).
const MIN_DEV_HOURS = 2;
const MIN_QA_HOURS = 1;

export function computeFeatureHours(
  feature: Pick<ScopeFeature, "platforms" | "complexity" | "lowcode_factor" | "is_active">,
  config: ScopeConfig,
  riskMargin = 0
): FeatureHours {
  const zero: FeatureHours = { product: 0, development: 0, qa: 0, total: 0 };
  if (!feature.is_active) return zero;

  const base =
    config.complexity_ranges[feature.complexity] ?? config.complexity_ranges.media;
  const platforms: ScopePlatform[] =
    feature.platforms.length > 0 ? feature.platforms : ["web"];
  const platformMult = Math.max(
    ...platforms.map((p) => config.platform_multipliers[p] ?? 1)
  );
  const margin = 1 + Math.min(1, Math.max(0, riskMargin || 0));
  const aiFactor = Math.min(1, Math.max(0.05, config.ai_factor || 1));

  let development = base * platformMult * aiFactor * margin;
  development = Math.max(development, MIN_DEV_HOURS);

  const qa = Math.max(development * config.buffers.qa, MIN_QA_HOURS);
  const product = config.product_ranges?.[feature.complexity] ?? 0;
  const total = development + qa + product;

  return {
    product: round1(product),
    development: round1(development),
    qa: round1(qa),
    total: round1(total),
  };
}

/** Recalcula as horas de uma feature já editada. */
export function withRecomputedHours(
  feature: ScopeFeature,
  config: ScopeConfig,
  riskMargin = 0
): ScopeFeature {
  return { ...feature, hours: computeFeatureHours(feature, config, riskMargin) };
}

export interface ScopeSummary {
  totalHours: number;
  estimatedValue: number;
  byDiscipline: { product: number; development: number; qa: number };
  byPhase: Record<string, number>;
  byPlatform: Record<ScopePlatform, number>;
  mandatoryModules: number;
  lowConfidenceFeatures: number;
  activeFeatures: number;
}

const ALL_PLATFORMS: ScopePlatform[] = ["web", "mobile_native", "mobile_responsive"];

/** Agrega os totais do escopo para o painel de resumo. */
export function summarizeScope(scope: ScopeData, config: ScopeConfig): ScopeSummary {
  const byDiscipline = { product: 0, development: 0, qa: 0 };
  const byPhase: Record<string, number> = {};
  const byPlatform: Record<ScopePlatform, number> = {
    web: 0,
    mobile_native: 0,
    mobile_responsive: 0,
  };
  let totalHours = 0;
  let mandatoryModules = 0;
  let lowConfidenceFeatures = 0;
  let activeFeatures = 0;

  for (const mod of scope.modules) {
    if (mod.is_mandatory) mandatoryModules += 1;
    for (const f of mod.features) {
      if (!f.is_active) continue;
      activeFeatures += 1;
      if (f.confidence === "low") lowConfidenceFeatures += 1;

      byDiscipline.product += f.hours.product;
      byDiscipline.development += f.hours.development;
      byDiscipline.qa += f.hours.qa;
      totalHours += f.hours.total;

      byPhase[f.phase] = (byPhase[f.phase] ?? 0) + f.hours.total;

      // Rateia o total da feature entre as plataformas em que ela existe.
      const platforms = f.platforms.length > 0 ? f.platforms : (["web"] as ScopePlatform[]);
      const share = f.hours.total / platforms.length;
      for (const p of platforms) byPlatform[p] += share;
    }
  }

  const round1 = (n: number) => Math.round(n * 10) / 10;
  byDiscipline.product = round1(byDiscipline.product);
  byDiscipline.development = round1(byDiscipline.development);
  byDiscipline.qa = round1(byDiscipline.qa);
  totalHours = round1(totalHours);
  for (const key of Object.keys(byPhase)) byPhase[key] = round1(byPhase[key]);
  for (const p of ALL_PLATFORMS) byPlatform[p] = round1(byPlatform[p]);

  return {
    totalHours,
    estimatedValue: round1(totalHours * config.hourly_rate),
    byDiscipline,
    byPhase,
    byPlatform,
    mandatoryModules,
    lowConfidenceFeatures,
    activeFeatures,
  };
}

/** Serializa o escopo em Markdown para export/clipboard. */
export function scopeToMarkdown(
  scope: ScopeData,
  config: ScopeConfig,
  projectName: string
): string {
  const summary = summarizeScope(scope, config);
  const modelLabel = scope.sales_model ? PT_SALES_MODEL[scope.sales_model] : "—";
  const marginPct = Math.round((scope.risk_margin ?? 0) * 100);
  const lines: string[] = [
    `# Escopo — ${projectName}`,
    "",
    `**Modelo de venda:** ${modelLabel} · **Margem de risco:** ${marginPct}%`,
    `**Total:** ${formatHm(summary.totalHours)} (h:mm)`,
    `**Produto:** ${formatHm(summary.byDiscipline.product)} · **Dev:** ${formatHm(summary.byDiscipline.development)} · **QA:** ${formatHm(summary.byDiscipline.qa)}`,
    "",
  ];

  for (const mod of scope.modules) {
    lines.push(`## ${mod.name}${mod.is_mandatory ? " (obrigatório)" : ""}`);
    if (mod.description_client) lines.push(`_${mod.description_client}_`);
    lines.push("");
    lines.push("| Funcionalidade | Fase | Produto | Dev | QA | Total |");
    lines.push("|---|---|---|---|---|---|");
    for (const f of mod.features) {
      const active = f.is_active ? "" : " _(inativa)_";
      lines.push(
        `| ${f.title}${active} | ${f.phase} | ${formatHm(f.hours.product)} | ${formatHm(f.hours.development)} | ${formatHm(f.hours.qa)} | ${formatHm(f.hours.total)} |`
      );
    }
    lines.push("");
  }

  return lines.join("\n");
}

export const PT_COMPLEXITY: Record<ScopeComplexity, string> = {
  simples: "Simples",
  media: "Média",
  dificil: "Difícil",
};

export const PT_PLATFORM: Record<ScopePlatform, string> = {
  web: "Web",
  mobile_native: "Mobile nativo",
  mobile_responsive: "Mobile responsivo",
};

export function recomputeModule(
  mod: ScopeModule,
  config: ScopeConfig,
  riskMargin = 0
): ScopeModule {
  return {
    ...mod,
    features: mod.features.map((f) => withRecomputedHours(f, config, riskMargin)),
  };
}

export const PT_SALES_MODEL: Record<NonNullable<ScopeData["sales_model"]>, string> = {
  fechado: "Escopo fechado",
  banco_horas: "Banco de horas",
};

/** Formata horas decimais como h:mm (ex.: 1.6 → "1:36", 0.1 → "0:06"). */
export function formatHm(hours: number): string {
  const totalMin = Math.round((Number.isFinite(hours) ? hours : 0) * 60);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return `${h}:${String(m).padStart(2, "0")}`;
}

/** Converte "h:mm" (ou número) de volta para horas decimais. */
export function parseHm(value: string): number {
  if (!value) return 0;
  const cleaned = String(value).replace(/[^\d:]/g, "");
  if (cleaned.includes(":")) {
    const [hh, mm = "0"] = cleaned.split(":");
    return (parseInt(hh, 10) || 0) + (parseInt(mm, 10) || 0) / 60;
  }
  return parseInt(cleaned, 10) || 0;
}
