import { completeText } from "./anthropic-client";
import { truncate } from "./analysis-service";
import { QA_TEST_CASES_SYSTEM } from "./spec-docs";
import { Gap } from "./types";

const QA_STEP_DEADLINE_MS = 55_000;
const QA_INTRO_MAX_TOKENS = 8_000;
const QA_PREMISES_MAX_TOKENS = 6_000;
const QA_TEST_CASES_MAX_TOKENS = 10_000;
const QA_CHECKLIST_MAX_TOKENS = 4_000;
const MODULES_PER_BATCH = 3;

export type QaStepKind = "intro" | "premises" | "test_cases" | "checklist";

export interface QaStepPlan {
  id: string;
  label: string;
  kind: QaStepKind;
  batchIndex?: number;
  totalBatches?: number;
  moduleRange?: { start: number; end: number };
}

export interface QaGenParams {
  discovery: string;
  prototype?: string | null;
  gaps: Gap[];
  respostas?: Record<string, string>;
  prd?: string | null;
  productName?: string;
}

export interface QaStepResult {
  stepId: string;
  content: string;
  index: number;
  total: number;
  done: boolean;
}

export interface QaDocValidation {
  complete: boolean;
  issues: string[];
}

/** Estima quantos módulos/funcionalidades o projeto tem para dimensionar os lotes de CTs. */
export function estimateModuleCount(discovery: string): number {
  const numbered = discovery.match(/^\d+\.\s+\*\*/gm);
  if (numbered && numbered.length >= 4) return numbered.length;

  const headers = discovery.match(/^##\s+/gm);
  if (headers && headers.length >= 5) return Math.min(headers.length * 2, 24);

  const len = discovery.length;
  if (len > 120_000) return 20;
  if (len > 60_000) return 14;
  if (len > 25_000) return 8;
  return 5;
}

export function planQaTestCasesSteps(discovery: string): QaStepPlan[] {
  const moduleCount = estimateModuleCount(discovery);
  const numBatches = Math.max(1, Math.ceil(moduleCount / MODULES_PER_BATCH));

  const steps: QaStepPlan[] = [
    { id: "intro", label: "Contexto e mapa de módulos", kind: "intro" },
    { id: "premises", label: "Premissas e pontos em aberto", kind: "premises" },
  ];

  for (let i = 0; i < numBatches; i++) {
    const start = i * MODULES_PER_BATCH + 1;
    const end = Math.min((i + 1) * MODULES_PER_BATCH, moduleCount);
    steps.push({
      id: `test_cases_${i + 1}`,
      label: `Casos de teste (módulos ${start}–${end})`,
      kind: "test_cases",
      batchIndex: i + 1,
      totalBatches: numBatches,
      moduleRange: { start, end },
    });
  }

  steps.push({ id: "checklist", label: "Checklist de cobertura", kind: "checklist" });
  return steps;
}

export function validateQaTestCasesDoc(content: string): QaDocValidation {
  const issues: string[] = [];
  const trimmed = content.trim();

  if (!trimmed) {
    return { complete: false, issues: ["Documento vazio."] };
  }

  if (!/^##\s+1\.\s+Contexto/m.test(trimmed)) {
    issues.push("Seção 1 (Contexto) ausente.");
  }
  if (!/^##\s+2\.\s+Mapa/m.test(trimmed)) {
    issues.push("Seção 2 (Mapa de módulos) ausente.");
  }
  if (!/^##\s+3\.\s+Premissas/m.test(trimmed)) {
    issues.push("Seção 3 (Premissas e Pontos em Aberto) ausente.");
  }
  if (!/^##\s+4\.\s+Casos de Teste/m.test(trimmed)) {
    issues.push("Seção 4 (Casos de Teste) ausente.");
  }
  if (!/^##\s+5\./m.test(trimmed)) {
    issues.push("Seção 5 (Checklist de cobertura) ausente.");
  }

  const ctCount = [...trimmed.matchAll(/###\s+CT\d+/gi)].length;
  if (ctCount === 0) {
    issues.push("Nenhum caso de teste (CT###) encontrado.");
  }

  const hasSec3 = /^##\s+3\.\s+Premissas/m.test(trimmed);
  const hasSec4 = /^##\s+4\.\s+Casos/m.test(trimmed);
  if (hasSec3 && !hasSec4) {
    issues.push("Geração interrompida após a seção 3 — faltam os casos de teste.");
  }

  const lastLine = trimmed.split("\n").pop()?.trim() ?? "";
  if (
    lastLine &&
    /^\d+\.\s+\*\*/.test(lastLine) === false &&
    /^##/.test(lastLine) === false &&
    /^---$/.test(lastLine) === false &&
    !/[.!?;:)\]]$/.test(lastLine) &&
    !/^\|/.test(lastLine)
  ) {
    if (/^\s*-\s+\S/.test(lastLine) && lastLine.length < 120) {
      issues.push("Documento parece truncado (última linha incompleta).");
    }
  }

  return { complete: issues.length === 0, issues };
}

function countExistingCases(sections: Record<string, string>): number {
  let max = 0;
  for (const [key, text] of Object.entries(sections)) {
    if (!key.startsWith("test_cases_")) continue;
    for (const m of text.matchAll(/###\s+CT(\d+)/gi)) {
      max = Math.max(max, parseInt(m[1], 10));
    }
  }
  return max;
}

function buildSharedContext(params: QaGenParams): string {
  const parts: string[] = [];

  if (params.productName) {
    parts.push(`# Produto: ${params.productName}`);
  }

  parts.push("\n\n# Discovery estruturado (extraído do FigJam)\n");
  parts.push(truncate(params.discovery, 60_000));

  if (params.prototype?.trim()) {
    parts.push("\n\n# Protótipo estruturado (extraído do Figma Design)\n");
    parts.push(truncate(params.prototype, 40_000));
  }

  if (params.prd?.trim()) {
    parts.push("\n\n# PRD já gerado\n");
    parts.push(truncate(params.prd, 40_000));
  }

  const respondidos = params.gaps.filter((g) => params.respostas?.[g.id]?.trim());
  if (respondidos.length > 0) {
    parts.push("\n\n# Respostas a gaps\n");
    for (const gap of respondidos.slice(0, 30)) {
      parts.push(
        `- [${gap.localizacao}] ${gap.titulo}: ${params.respostas![gap.id].trim()}`
      );
    }
  }

  const abertos = params.gaps.filter(
    (g) => g.status !== "resolvido" && !params.respostas?.[g.id]?.trim()
  );
  if (abertos.length > 0) {
    parts.push("\n\n# Gaps ainda em aberto\n");
    for (const gap of abertos.slice(0, 30)) {
      parts.push(
        `- [${gap.severidade}] [${gap.localizacao}] ${gap.titulo}: ${gap.descricao}`
      );
    }
  }

  return parts.join("\n");
}

function stepInstruction(
  step: QaStepPlan,
  sections: Record<string, string>
): string {
  switch (step.kind) {
    case "intro":
      return [
        "Gere APENAS as seções 1 e 2 do documento de Casos de Teste:",
        "1. Título + Contexto rápido",
        "2. Mapa de módulos/funcionalidades identificadas (lista numerada completa de tudo que existe no material)",
        "NÃO inclua premissas, casos de teste nem checklist.",
        "Use o título principal `# Casos de Teste (Funcionais) — [Nome do Produto]`.",
      ].join("\n");

    case "premises":
      return [
        "Gere APENAS a seção 3: Premissas e Pontos em Aberto.",
        "Inclua subseções 'Premissas Assumidas' e 'Pontos em Aberto'.",
        "Baseie-se no mapa de módulos já gerado abaixo.",
        "NÃO inclua casos de teste nem checklist.",
        "Comece com `## 3. Premissas e Pontos em Aberto`.",
      ].join("\n");

    case "test_cases": {
      const startCt = countExistingCases(sections) + 1;
      const range = step.moduleRange!;
      const isFirst = step.batchIndex === 1;
      return [
        isFirst
          ? "Gere a seção 4 iniciando com `## 4. Casos de Teste`."
          : "Continue a seção 4 (NÃO repita o cabeçalho `## 4.`).",
        `Gere casos de teste SOMENTE para os módulos numerados ${range.start} a ${range.end} do mapa (seção 2).`,
        `Numere a partir de CT${String(startCt).padStart(3, "0")}.`,
        "Siga o template obrigatório de cada CT (Objetivo, Pré-Condições, Dados de Teste, Passos em tabela, Pós-Condições, Critérios de Aceite).",
        "NÃO inclua checklist.",
      ].join("\n");
    }

    case "checklist":
      return [
        "Gere APENAS a seção 5: Checklist de cobertura por módulo.",
        "Liste cada módulo do mapa (seção 2) com os CTs que o cobrem e lacunas, se houver.",
        "Comece com `## 5. Checklist de cobertura por módulo`.",
      ].join("\n");
  }
}

function buildStepPrompt(
  params: QaGenParams,
  step: QaStepPlan,
  sections: Record<string, string>
): string {
  const parts: string[] = [];
  parts.push(`# Tarefa\n${stepInstruction(step, sections)}`);
  parts.push(buildSharedContext(params));

  if (sections.intro?.trim()) {
    parts.push("\n\n# Seção já gerada: Contexto e mapa\n");
    parts.push(truncate(sections.intro, 20_000));
  }
  if (sections.premises?.trim() && step.kind !== "intro") {
    parts.push("\n\n# Seção já gerada: Premissas\n");
    parts.push(truncate(sections.premises, 12_000));
  }

  const testSections = Object.keys(sections)
    .filter((k) => k.startsWith("test_cases_"))
    .sort()
    .map((k) => sections[k])
    .filter(Boolean);
  if (testSections.length > 0 && step.kind === "checklist") {
    parts.push("\n\n# Casos de teste já gerados (resumo)\n");
    parts.push(
      truncate(
        testSections.join("\n\n"),
        30_000
      )
    );
  }

  parts.push("\n\nGere agora apenas o conteúdo solicitado, em markdown.");
  return parts.join("\n");
}

function maxTokensForStep(kind: QaStepKind): number {
  switch (kind) {
    case "intro":
      return QA_INTRO_MAX_TOKENS;
    case "premises":
      return QA_PREMISES_MAX_TOKENS;
    case "test_cases":
      return QA_TEST_CASES_MAX_TOKENS;
    case "checklist":
      return QA_CHECKLIST_MAX_TOKENS;
  }
}

export function assembleQaTestCasesDoc(
  productName: string,
  sections: Record<string, string>,
  steps: QaStepPlan[]
): string {
  const intro = sections.intro?.trim() ?? "";
  const premises = sections.premises?.trim() ?? "";
  const testParts = steps
    .filter((s) => s.kind === "test_cases")
    .map((s) => sections[s.id]?.trim())
    .filter(Boolean);
  const checklist = sections.checklist?.trim() ?? "";

  const parts: string[] = [];

  if (intro) parts.push(intro);
  if (premises) parts.push(premises);
  if (testParts.length > 0) parts.push(testParts.join("\n\n"));
  if (checklist) parts.push(checklist);

  let body = parts.join("\n\n---\n\n");

  if (!body.startsWith("#")) {
    body = `# Casos de Teste (Funcionais) — ${productName}\n\n${body}`;
  }

  return body.trimEnd() + "\n";
}

export async function generateQaTestCasesStep(
  params: QaGenParams,
  stepId: string,
  sections: Record<string, string> = {}
): Promise<QaStepResult> {
  const steps = planQaTestCasesSteps(params.discovery);
  const index = steps.findIndex((s) => s.id === stepId);

  if (index === -1) {
    throw new Error(`Passo de QA desconhecido: ${stepId}`);
  }

  const step = steps[index];
  const prompt = buildStepPrompt(params, step, sections);

  const content = await completeText({
    system: QA_TEST_CASES_SYSTEM,
    prompt,
    maxTokens: maxTokensForStep(step.kind),
    deadlineMs: QA_STEP_DEADLINE_MS,
  });

  return {
    stepId,
    content: content.trim(),
    index,
    total: steps.length,
    done: index === steps.length - 1,
  };
}
