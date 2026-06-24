import { completeText } from "./anthropic-client";
import { truncate } from "./analysis-service";
import {
  extractDesignTokensSection,
  stripDesignTokensSection,
} from "./parse-figma-tokens";
import { Gap } from "./types";

const DS_STEP_DEADLINE_MS = 55_000;
const DS_SECTION_MAX_TOKENS = 6_000;
const MAX_WIREFRAME_SAMPLE_CHARS = 35_000;

export type DesignSystemSectionKind =
  | "components"
  | "layout"
  | "accessibility";

export interface DesignSystemStepPlan {
  id: string;
  label: string;
  kind: DesignSystemSectionKind | "foundations";
  deterministic?: boolean;
}

export interface DesignSystemGenParams {
  discovery: string;
  prototype?: string | null;
  gaps: Gap[];
  respostas?: Record<string, string>;
  prd?: string | null;
  productName?: string;
}

export interface DesignSystemStepResult {
  stepId: string;
  content: string;
  index: number;
  total: number;
  done: boolean;
}

const DESIGN_SYSTEM_SECTION_SYSTEM = `Você é um(a) Design Systems Lead gerando documentação técnica para implementação numa IDE com IA.

Use EXCLUSIVAMENTE o material fornecido: tokens/estilos extraídos do Figma (com valores hex e tipografia quando disponíveis), wireframes do protótipo, Discovery, gaps/respostas e PRD.

REGRAS:
- Quando um valor já estiver nos tokens extraídos (hex, px, nome de estilo Figma), use-o literalmente — NÃO substitua por [A DEFINIR].
- Onde a informação não existir no material, escreva "[A DEFINIR — depende de X]".
- NUNCA invente cores, fontes ou medidas.
- Escreva em português, markdown bem estruturado.
- Responda APENAS com o markdown da seção solicitada, sem cercas de código ao redor do documento inteiro.`;

export function planDesignSystemSteps(): DesignSystemStepPlan[] {
  return [
    {
      id: "foundations",
      label: "Fundamentos (tokens extraídos do Figma)",
      kind: "foundations",
      deterministic: true,
    },
    {
      id: "components",
      label: "Inventário de componentes",
      kind: "components",
    },
    {
      id: "layout",
      label: "Layout e navegação",
      kind: "layout",
    },
    {
      id: "accessibility",
      label: "Acessibilidade",
      kind: "accessibility",
    },
  ];
}

function buildFoundationsSection(prototype: string | null | undefined): string {
  const extracted = prototype ? extractDesignTokensSection(prototype) : null;
  if (extracted) {
    const body = extracted
      .replace(/<!-- EXTRAK_DESIGN_TOKENS_START -->/g, "")
      .replace(/<!-- EXTRAK_DESIGN_TOKENS_END -->/g, "")
      .trim();
    return `## 1. Fundamentos e tokens\n\n${body}`;
  }

  return [
    "## 1. Fundamentos e tokens",
    "",
    "_Nenhum token visual foi extraído do Figma. Re-extraia o protótipo ou verifique estilos/variables no arquivo._",
  ].join("\n");
}

function wireframeSample(prototype: string | null | undefined): string | null {
  if (!prototype?.trim()) return null;
  const stripped = stripDesignTokensSection(prototype);
  return truncate(stripped, MAX_WIREFRAME_SAMPLE_CHARS);
}

function sectionInstruction(kind: DesignSystemSectionKind): string {
  switch (kind) {
    case "components":
      return [
        "Gere a seção **Inventário de componentes de UI** do Design System.",
        "Organize por categoria (ex.: Navegação, Formulários, Feedback, Dados).",
        "Para cada componente: nome, descrição, variantes/estados inferíveis, tokens de cor/tipo associados (use os nomes dos estilos Figma quando houver), e exemplos de telas do protótipo.",
        "Priorize componentes publicados no Figma listados nos tokens e elementos recorrentes nos wireframes (Sidebar, botões, tabelas, modais, inputs, badges de status).",
      ].join("\n");
    case "layout":
      return [
        "Gere a seção **Layout e padrões de navegação**.",
        "Documente: grid/viewport (ex.: 1280px desktop), estrutura shell (sidebar + header + conteúdo), padrões de página (listagem, detalhe, formulário, modal/backdrop), hierarquia de navegação entre módulos.",
        "Use dimensões de telas do protótipo quando disponíveis.",
      ].join("\n");
    case "accessibility":
      return [
        "Gere a seção **Diretrizes de acessibilidade** aplicáveis ao produto.",
        "Cubra: contraste (referenciando cores extraídas), foco/teclado, labels em formulários, mensagens de erro, estados em badges/status, e recomendações WCAG pragmáticas para o time de dev.",
        "Marque [A DEFINIR] onde o protótipo não permitir validar.",
      ].join("\n");
  }
}

function buildSectionPrompt(
  params: DesignSystemGenParams,
  kind: DesignSystemSectionKind,
  sections: Record<string, string>
): string {
  const parts: string[] = [];
  parts.push(`# Tarefa: ${sectionInstruction(kind)}\n`);

  if (params.productName) {
    parts.push(`# Produto: ${params.productName}\n`);
  }

  const tokens = params.prototype
    ? extractDesignTokensSection(params.prototype)
    : null;
  if (tokens) {
    parts.push("# Tokens e estilos extraídos do Figma\n");
    parts.push(tokens);
  }

  const sample = wireframeSample(params.prototype);
  if (sample) {
    parts.push("\n\n# Amostra de wireframes (protótipo Figma)\n");
    parts.push(sample);
  } else if (params.prototype?.trim()) {
    parts.push(
      "\n\n# Protótipo: NÃO disponível na amostra. Use tokens e Discovery."
    );
  }

  parts.push("\n\n# Discovery (trecho)\n");
  parts.push(truncate(params.discovery, 25_000));

  if (params.prd?.trim()) {
    parts.push("\n\n# PRD\n");
    parts.push(truncate(params.prd, 20_000));
  }

  if (sections.foundations?.trim()) {
    parts.push("\n\n# Seção já gerada: Fundamentos\n");
    parts.push(truncate(sections.foundations, 8_000));
  }

  const respondidos = params.gaps.filter((g) => params.respostas?.[g.id]?.trim());
  if (respondidos.length > 0) {
    parts.push("\n\n# Respostas a gaps\n");
    for (const gap of respondidos.slice(0, 20)) {
      parts.push(
        `- [${gap.localizacao}] ${gap.titulo}: ${params.respostas![gap.id].trim()}`
      );
    }
  }

  parts.push("\n\nGere agora apenas esta seção em markdown.");
  return parts.join("\n");
}

const SECTION_HEADINGS: Record<string, string> = {
  components: "## 2. Inventário de componentes",
  layout: "## 3. Layout e navegação",
  accessibility: "## 4. Acessibilidade",
};

export function assembleDesignSystem(
  productName: string,
  sections: Record<string, string>
): string {
  const ordered = planDesignSystemSteps()
    .map((s) => s.id)
    .filter((id) => sections[id]?.trim());

  const body = ordered
    .map((id) => {
      const content = sections[id]!.trim();
      if (id === "foundations") return content;
      const heading = SECTION_HEADINGS[id];
      if (heading && !content.startsWith("##")) {
        return `${heading}\n\n${content}`;
      }
      return content;
    })
    .join("\n\n---\n\n");

  return `# Design System — ${productName}\n\n${body}`.trimEnd() + "\n";
}

export async function generateDesignSystemStep(
  params: DesignSystemGenParams,
  stepId: string,
  sections: Record<string, string> = {}
): Promise<DesignSystemStepResult> {
  const steps = planDesignSystemSteps();
  const index = steps.findIndex((s) => s.id === stepId);

  if (index === -1) {
    throw new Error(`Passo de Design System desconhecido: ${stepId}`);
  }

  const step = steps[index];

  if (step.deterministic || step.kind === "foundations") {
    const content = buildFoundationsSection(params.prototype);
    return {
      stepId,
      content,
      index,
      total: steps.length,
      done: index === steps.length - 1,
    };
  }

  const prompt = buildSectionPrompt(
    params,
    step.kind as DesignSystemSectionKind,
    sections
  );

  const content = await completeText({
    system: DESIGN_SYSTEM_SECTION_SYSTEM,
    prompt,
    maxTokens: DS_SECTION_MAX_TOKENS,
    deadlineMs: DS_STEP_DEADLINE_MS,
  });

  return {
    stepId,
    content: content.trim(),
    index,
    total: steps.length,
    done: index === steps.length - 1,
  };
}

/** Gera o Design System completo em passos (uso interno). */
export async function generateDesignSystemMultiStep(
  params: DesignSystemGenParams
): Promise<string> {
  const steps = planDesignSystemSteps();
  const sections: Record<string, string> = {};

  for (const step of steps) {
    const result = await generateDesignSystemStep(params, step.id, sections);
    sections[result.stepId] = result.content;
  }

  return assembleDesignSystem(params.productName ?? "Produto", sections);
}
