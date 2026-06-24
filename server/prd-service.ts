import { completeText } from "./anthropic-client";
import {
  PRD_SECTION_SYSTEM,
  buildPrdSectionPrompt,
  type PrdSectionKind,
} from "./prompts";
import {
  cappedPrototype,
  chunkDiscovery,
  MAX_FULL_DISCOVERY_CHARS,
  truncate,
} from "./analysis-service";
import { getSupabaseAdmin } from "./supabase";
import { Gap } from "./types";

const PRD_STEP_DEADLINE_MS = 58_000;
const PRD_DEFAULT_MAX_TOKENS = 6_144;
const PRD_FUNCTIONAL_MAX_TOKENS = 4_096;
/** Chunks menores → cada passo de RF termina antes do timeout. */
const FUNCTIONAL_CHUNK_CHARS = 10_000;

/** Teto de Discovery por tipo de seção (evita prompts gigantes e timeout). */
const DISCOVERY_LIMIT_BY_SECTION: Partial<Record<PrdSectionKind, number>> = {
  overview: 100_000,
  personas: 70_000,
  scope: 100_000,
  nonfunctional: 70_000,
  flows: 60_000,
  metrics: 60_000,
  acceptance: 70_000,
  risks: 60_000,
};

interface DiscoverySection {
  title: string;
  body: string;
}

function parseDiscoverySections(discovery: string): DiscoverySection[] {
  const sections: DiscoverySection[] = [];
  let current: DiscoverySection | null = null;

  for (const line of discovery.split("\n")) {
    if (line.startsWith("## ")) {
      if (current) sections.push(current);
      current = { title: line.slice(3).trim(), body: "" };
      continue;
    }
    if (current) {
      current.body += (current.body ? "\n" : "") + line;
    }
  }
  if (current) sections.push(current);
  return sections;
}

/** Seleciona trechos relevantes do Discovery para cada seção do PRD. */
export function discoveryForPrdSection(
  kind: PrdSectionKind,
  rawDiscovery: string
): string {
  const discovery = truncate(rawDiscovery, MAX_FULL_DISCOVERY_CHARS);
  const hardLimit = DISCOVERY_LIMIT_BY_SECTION[kind] ?? 80_000;

  if (kind === "overview" || kind === "functional") {
    return truncate(discovery, hardLimit);
  }

  const keywords: Record<Exclude<PrdSectionKind, "overview" | "functional">, RegExp> = {
    personas:
      /persona|perfil|usu[aá]rio|p[uú]blico|cliente|stakeholder|cargo|papel|equipe|colaborador|almoxarif|engenharia|comercial|qualidade|suprimento|produ[cç]/i,
    scope: /escopo|m[oó]dulo|fase|funcionalidade|feature|backoffice|produto|sistema|entra|fora|mvp|roadmap/i,
    nonfunctional:
      /n[aã]o[- ]funcional|seguran[cç]a|performance|disponibilidade|integra[cç]|conformidade|usabilidade|infra|escalabilidade|lgpd|backup/i,
    flows: /fluxo|tela|navega|jornada|wireframe|protot|conector|screen|ui|ux/i,
    metrics: /m[eé]trica|kpi|indicador|meta|baseline|sucesso|okr|ebitda|receita|margem/i,
    acceptance: /aceite|crit[eé]rio|teste|valida[cç]|definition of done|done/i,
    risks: /risco|depend[eê]ncia|premissa|bloqueio|incerteza|terceiro|mitiga/i,
  };

  const re = keywords[kind as Exclude<PrdSectionKind, "overview" | "functional">];
  const sections = parseDiscoverySections(discovery);
  const preamble = discovery.split("\n## ")[0]?.trim() ?? "";
  const matched = sections.filter(
    (s) => re.test(s.title) || re.test(s.body.slice(0, 800))
  );

  if (matched.length === 0) {
    return truncate(discovery, hardLimit);
  }

  const parts = [preamble, ""];
  for (const section of matched) {
    parts.push(`## ${section.title}`, section.body, "");
  }

  const focused = parts.join("\n").trim();
  if (focused.length < hardLimit * 0.35) {
    return truncate(`${focused}\n\n---\n\n${discovery}`, hardLimit);
  }
  return truncate(focused, hardLimit);
}

/** Rascunho persistido no servidor — evita reenviar seções grandes a cada passo. */
export async function loadPrdDraftSections(
  projectId: string
): Promise<Record<string, string>> {
  const admin = getSupabaseAdmin();
  const { data } = await admin
    .from("project_docs")
    .select("content_md")
    .eq("project_id", projectId)
    .eq("kind", "prd_draft")
    .maybeSingle();

  if (!data?.content_md) return {};
  try {
    return JSON.parse(data.content_md) as Record<string, string>;
  } catch {
    return {};
  }
}

export async function savePrdDraftSections(
  projectId: string,
  sections: Record<string, string>
): Promise<void> {
  const admin = getSupabaseAdmin();
  await admin.from("project_docs").upsert(
    {
      project_id: projectId,
      kind: "prd_draft",
      content_md: JSON.stringify(sections),
      version: 1,
    },
    { onConflict: "project_id,kind" }
  );
}

export async function clearPrdDraftSections(projectId: string): Promise<void> {
  const admin = getSupabaseAdmin();
  await admin
    .from("project_docs")
    .delete()
    .eq("project_id", projectId)
    .eq("kind", "prd_draft");
}

export function completedPrdStepIds(
  rawDiscovery: string,
  sections: Record<string, string>
): string[] {
  return planPrdSteps(rawDiscovery)
    .map((s) => s.id)
    .filter((id) => Boolean(sections[id]?.trim()));
}

export interface PrdStepPlan {
  id: string;
  label: string;
  kind: PrdSectionKind | "open-gaps";
  /** Passo gerado por código, sem chamada à IA. */
  deterministic?: boolean;
}

export interface PrdGenParams {
  discovery: string;
  prototype?: string | null;
  gaps: Gap[];
  respostas?: Record<string, string>;
  productName?: string;
}

export interface PrdStepResult {
  stepId: string;
  content: string;
  index: number;
  total: number;
  done: boolean;
}

function openGaps(gaps: Gap[], respostas: Record<string, string>): Gap[] {
  return gaps.filter(
    (g) => g.status !== "resolvido" && !respostas[g.id]?.trim()
  );
}

/** Lista completa de passos do PRD (inclui chunks dinâmicos de requisitos funcionais). */
export function planPrdSteps(rawDiscovery: string): PrdStepPlan[] {
  const discovery = truncate(rawDiscovery, MAX_FULL_DISCOVERY_CHARS);
  const functionalChunks = chunkDiscovery(discovery, FUNCTIONAL_CHUNK_CHARS);
  const steps: PrdStepPlan[] = [
    { id: "overview", label: "Visão geral e objetivo", kind: "overview" },
    { id: "personas", label: "Personas e público-alvo", kind: "personas" },
    { id: "scope", label: "Escopo", kind: "scope" },
  ];

  functionalChunks.forEach((_chunk, index) => {
    steps.push({
      id: `functional-${index}`,
      label:
        functionalChunks.length > 1
          ? `Requisitos funcionais (${index + 1}/${functionalChunks.length})`
          : "Requisitos funcionais",
      kind: "functional",
    });
  });

  steps.push(
    { id: "nonfunctional", label: "Requisitos não-funcionais", kind: "nonfunctional" },
    { id: "flows", label: "Fluxos e telas", kind: "flows" },
    { id: "metrics", label: "Métricas de sucesso", kind: "metrics" },
    { id: "acceptance", label: "Critérios de aceite", kind: "acceptance" },
    { id: "risks", label: "Riscos e dependências", kind: "risks" },
    {
      id: "open-gaps",
      label: "Pontos em aberto e bloqueios",
      kind: "open-gaps",
      deterministic: true,
    }
  );

  return steps;
}

/** Seção 10 gerada programaticamente — garante que TODOS os gaps apareçam. */
export function buildOpenGapsSection(
  gaps: Gap[],
  respostas: Record<string, string>
): string {
  const abertos = openGaps(gaps, respostas);
  const lines: string[] = ["## 10. Pontos em aberto e bloqueios", ""];

  if (abertos.length === 0) {
    lines.push("Nenhum ponto em aberto.");
    return lines.join("\n");
  }

  const bloqueadores = abertos.filter((g) => g.severidade === "alta");
  const media = abertos.filter((g) => g.severidade === "media");
  const baixa = abertos.filter((g) => g.severidade === "baixa");

  lines.push(
    `Total: **${abertos.length}** gap(s) em aberto (${bloqueadores.length} bloqueador(es), ${media.length} média, ${baixa.length} baixa).`,
    ""
  );

  const formatGap = (gap: Gap, index: number) => {
    const sev = (gap.severidade ?? "media").toUpperCase();
    const parts = [
      `${index}. **[${sev}]** ${gap.titulo}`,
      `   - **Localização:** ${gap.localizacao ?? "—"}`,
      `   - **Categoria:** ${gap.categoria ?? "—"}`,
      `   - **Descrição:** ${gap.descricao ?? "—"}`,
    ];
    if (gap.sugestao) {
      parts.push(`   - **Para fechar:** ${gap.sugestao}`);
    }
    return parts.join("\n");
  };

  if (bloqueadores.length > 0) {
    lines.push("### Bloqueadores (severidade alta)", "");
    bloqueadores.forEach((gap, i) => lines.push(formatGap(gap, i + 1), ""));
  }

  if (media.length > 0) {
    lines.push("### Severidade média", "");
    media.forEach((gap, i) => lines.push(formatGap(gap, i + 1), ""));
  }

  if (baixa.length > 0) {
    lines.push("### Severidade baixa", "");
    baixa.forEach((gap, i) => lines.push(formatGap(gap, i + 1), ""));
  }

  return lines.join("\n").trimEnd();
}

function discoveryChunkForFunctional(
  discovery: string,
  functionalIndex: number
): string {
  const chunks = chunkDiscovery(discovery, FUNCTIONAL_CHUNK_CHARS);
  return chunks[functionalIndex] ?? discovery;
}

function lastRfContinuationHint(sections: Record<string, string>): string | null {
  const parts = Object.entries(sections)
    .filter(([id]) => id.startsWith("functional-"))
    .sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }))
    .map(([, content]) => content);

  if (parts.length === 0) return null;

  const joined = parts.join("\n");
  const ids = [...joined.matchAll(/\bRF-(\d+)\b/gi)].map((m) => Number(m[1]));
  if (ids.length === 0) {
    return joined.length <= 1_500 ? joined : joined.slice(-1_500);
  }

  const last = Math.max(...ids);
  return (
    `Último requisito funcional gerado: RF-${String(last).padStart(3, "0")}. ` +
    `Continue a numeração a partir de RF-${String(last + 1).padStart(3, "0")}.`
  );
}

/** Monta o markdown final a partir das seções geradas. */
export function assemblePrd(
  productName: string,
  discovery: string,
  sections: Record<string, string>
): string {
  const ordered = planPrdSteps(discovery)
    .map((s) => s.id)
    .filter((id) => sections[id]?.trim());

  const body = ordered
    .map((id) => sections[id]!.trim())
    .join("\n\n---\n\n");

  return `# PRD — ${productName}\n\n${body}`.trimEnd() + "\n";
}

/** Gera um único passo do PRD. */
export async function generatePrdStep(
  params: PrdGenParams,
  stepId: string,
  sections: Record<string, string> = {}
): Promise<PrdStepResult> {
  const discovery = truncate(params.discovery, MAX_FULL_DISCOVERY_CHARS);
  const prototype = cappedPrototype(params.prototype);
  const respostas = params.respostas ?? {};
  const steps = planPrdSteps(discovery);
  const index = steps.findIndex((s) => s.id === stepId);

  if (index === -1) {
    throw new Error(`Passo de PRD desconhecido: ${stepId}`);
  }

  const step = steps[index];

  if (step.deterministic || step.kind === "open-gaps") {
    const content = buildOpenGapsSection(params.gaps, respostas);
    return {
      stepId,
      content,
      index,
      total: steps.length,
      done: index === steps.length - 1,
    };
  }

  const functionalIndex = stepId.startsWith("functional-")
    ? Number(stepId.replace("functional-", ""))
    : null;

  const prompt = buildPrdSectionPrompt({
    kind: step.kind as PrdSectionKind,
    discovery:
      functionalIndex != null
        ? discoveryChunkForFunctional(discovery, functionalIndex)
        : discoveryForPrdSection(step.kind as PrdSectionKind, params.discovery),
    prototype: step.kind === "flows" ? prototype : null,
    gaps: params.gaps,
    respostas,
    productName: params.productName,
    functionalIndex,
    functionalTotal: chunkDiscovery(discovery, FUNCTIONAL_CHUNK_CHARS).length,
    previousFunctional: lastRfContinuationHint(sections),
    previousSections:
      step.kind === "functional"
        ? { overview: sections.overview, scope: sections.scope }
        : sections,
  });

  const maxTokens =
    step.kind === "functional" ? PRD_FUNCTIONAL_MAX_TOKENS : PRD_DEFAULT_MAX_TOKENS;

  const content = await completeText({
    system: PRD_SECTION_SYSTEM,
    prompt,
    maxTokens,
    deadlineMs: PRD_STEP_DEADLINE_MS,
  });

  return {
    stepId,
    content: content.trim(),
    index,
    total: steps.length,
    done: index === steps.length - 1,
  };
}

/** Gera o PRD completo em múltiplos passos (uso interno / testes). */
export async function generatePrdMultiStep(params: PrdGenParams): Promise<string> {
  const discovery = truncate(params.discovery, MAX_FULL_DISCOVERY_CHARS);
  const steps = planPrdSteps(discovery);
  const sections: Record<string, string> = {};

  for (const step of steps) {
    const result = await generatePrdStep(params, step.id, sections);
    sections[result.stepId] = result.content;
  }

  return assemblePrd(params.productName ?? "Produto", discovery, sections);
}
