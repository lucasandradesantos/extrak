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

export function computeFeatureHours(
  feature: Pick<ScopeFeature, "platforms" | "complexity" | "lowcode_factor" | "is_active">,
  config: ScopeConfig,
  riskMargin = 0
): FeatureHours {
  const zero: FeatureHours = { product: 0, development: 0, qa: 0, total: 0 };
  if (!feature.is_active) return zero;

  const base =
    config.complexity_ranges[feature.complexity] ?? config.complexity_ranges.media;
  const lowcode = feature.lowcode_factor || 1;
  const platforms: ScopePlatform[] =
    feature.platforms.length > 0 ? feature.platforms : ["web"];
  const margin = 1 + Math.min(1, Math.max(0, riskMargin || 0));

  let development = 0;
  for (const platform of platforms) {
    const multiplier = config.platform_multipliers[platform] ?? 1;
    development += base * lowcode * multiplier;
  }
  development *= margin;

  let qa = development * config.buffers.qa;
  let product = development * config.buffers.product;
  let total = development + qa + product;

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
    `**Total:** ${summary.totalHours}h · **Valor estimado:** R$ ${summary.estimatedValue.toLocaleString("pt-BR")} (R$ ${config.hourly_rate}/h)`,
    `**Produto:** ${summary.byDiscipline.product}h · **Dev:** ${summary.byDiscipline.development}h · **QA:** ${summary.byDiscipline.qa}h`,
    "",
  ];

  for (const mod of scope.modules) {
    lines.push(`## ${mod.name}${mod.is_mandatory ? " (obrigatório)" : ""}`);
    if (mod.description_client) lines.push(`_${mod.description_client}_`);
    lines.push("");
    lines.push("| Feature | Plataformas | Fase | Complexidade | Low-code | Horas (P/D/QA) | Total |");
    lines.push("|---|---|---|---|---|---|---|");
    for (const f of mod.features) {
      const active = f.is_active ? "" : " _(inativa)_";
      lines.push(
        `| ${f.title}${active} | ${f.platforms.join(", ")} | ${f.phase} | ${PT_COMPLEXITY[f.complexity]} | ${f.lowcode_factor} | ${f.hours.product}/${f.hours.development}/${f.hours.qa} | ${f.hours.total}h |`
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
