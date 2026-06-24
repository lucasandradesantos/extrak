import { completeJson, completeText, countTokens } from "./anthropic-client";
import { normalizeGaps } from "./gaps";
import {
  COMPARE_SYSTEM,
  CRITIQUE_SYSTEM,
  buildComparePrompt,
  buildCritiquePrompt,
} from "./prompts";
import {
  SPEC_DOCS,
  SPEC_DOC_SYSTEM,
  type SpecDocKind,
  buildSpecDocPrompt,
} from "./spec-docs";
import { Gap } from "./types";

// Estimativa conservadora de tokens. Em pt-BR o texto estruturado costuma cair
// entre 3 e 4 chars/token; usamos 3,0 para NÃO subestimar (chunks menores e
// seguros), já que números, símbolos e markdown puxam a média para baixo.
const CHARS_PER_TOKEN = 3.0;
// ~8k tokens por chunk → cada passo fica mais rápido e o progresso aparece antes.
const MAX_DISCOVERY_TOKENS = 8_000;
export const MAX_DISCOVERY_CHARS = Math.floor(
  MAX_DISCOVERY_TOKENS * CHARS_PER_TOKEN
);
// Protótipo enviado na etapa de comparação (truncado por telas inteiras).
// Mantido enxuto para a etapa caber no teto serverless (Vercel Hobby = 60s):
// quanto menor o input, mais rápido o 1º token e mais tempo sobra pra geração.
const MAX_PROTOTYPE_CHARS = 80_000;
// PRD e comparação recebem o Discovery (quase) COMPLETO; o teto evita estourar a
// janela de contexto e o tempo de função em projetos grandes.
export const MAX_FULL_DISCOVERY_CHARS = 160_000;
// Spec docs com PRD já disponível: o PRD condensa o Discovery — não reenviar tudo.
const MAX_SPEC_DOC_DISCOVERY_CHARS = 60_000;
// Design System e docs visuais: o Protótipo é a fonte principal; Discovery enxuto.
const MAX_PROTOTYPE_FOCUSED_DISCOVERY_CHARS = 40_000;
// Design System: protótipo enxuto — tokens/componentes se repetem entre telas.
const MAX_DESIGN_SYSTEM_PROTOTYPE_CHARS = 50_000;

// Orçamento de tempo por chamada de IA dentro de um passo. Fica abaixo do teto
// de 60s da função serverless, deixando folga para leituras/gravações no banco.
// Ao atingir o limite, aproveitamos a saída parcial e o passo conclui mesmo
// assim (o parser recupera os gaps já gerados), evitando loop de timeout.
const STEP_AI_DEADLINE_MS = 48_000;
// Spec docs: orçamento um pouco maior (ainda cabe no teto de 60s com folga p/ DB).
const SPEC_DOC_AI_DEADLINE_MS = 52_000;

/** Estimativa local e barata de tokens (sem rede). Usada para dimensionar chunks. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/**
 * Quebra o Discovery em pedaços sob o orçamento, preferindo cortar nos
 * cabeçalhos de seção ("## ").
 */
export function chunkDiscovery(text: string, maxChars = MAX_DISCOVERY_CHARS): string[] {
  if (text.length <= maxChars) return [text];

  const lines = text.split("\n");
  const chunks: string[] = [];
  let current: string[] = [];
  let currentLen = 0;

  const flush = () => {
    if (current.length) {
      chunks.push(current.join("\n"));
      current = [];
      currentLen = 0;
    }
  };

  for (const line of lines) {
    const isHeader = line.startsWith("## ");
    const lineLen = line.length + 1;

    if (currentLen + lineLen > maxChars && current.length) {
      flush();
    } else if (isHeader && currentLen > maxChars * 0.6) {
      flush();
    }

    current.push(line);
    currentLen += lineLen;
  }

  flush();
  return chunks;
}

export function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return (
    text.slice(0, maxChars) +
    "\n\n[... conteúdo truncado por limite de tamanho ...]"
  );
}

/**
 * Trunca o texto do protótipo preservando TELAS inteiras (marcadores
 * "### Tela:"), nunca cortando uma tela no meio. Anexa um aviso com a contagem
 * de telas incluídas vs total quando algo é descartado.
 */
export function cappedPrototype(
  prototype: string | null | undefined,
  maxChars = MAX_PROTOTYPE_CHARS
): string | null {
  if (!prototype || !prototype.trim()) return null;
  if (prototype.length <= maxChars) return prototype;

  const marker = "### Tela:";
  const totalScreens = prototype.split(marker).length - 1;

  // Mantém o cabeçalho/preâmbulo + o máximo de blocos de tela que couberem.
  const firstScreen = prototype.indexOf(marker);
  if (firstScreen === -1 || firstScreen > maxChars) {
    return truncate(prototype, maxChars);
  }

  let cut = firstScreen;
  let included = 0;
  let searchFrom = firstScreen;
  while (true) {
    const next = prototype.indexOf(marker, searchFrom + marker.length);
    const blockEnd = next === -1 ? prototype.length : next;
    if (blockEnd > maxChars) break;
    cut = blockEnd;
    included += 1;
    if (next === -1) break;
    searchFrom = next;
  }

  if (included === 0) {
    // Nem uma tela inteira coube: cai para o corte cego, mas avisa.
    return (
      truncate(prototype, maxChars) +
      `\n\n[... protótipo grande: 0 de ${totalScreens} telas couberam no limite ...]`
    );
  }

  return (
    prototype.slice(0, cut).trimEnd() +
    `\n\n[... ${included} de ${totalScreens} telas incluídas (limite de tamanho); ${
      totalScreens - included
    } tela(s) omitida(s) ...]`
  );
}

export interface CritiqueChunkParams {
  discoveryChunk: string;
  previousGaps?: Gap[];
  respostas?: Record<string, string>;
}

/** Critica um trecho (chunk) do Discovery e devolve os gaps normalizados. */
export async function critiqueDiscoveryChunk(
  params: CritiqueChunkParams
): Promise<Gap[]> {
  const prompt = buildCritiquePrompt({
    discovery: params.discoveryChunk,
    previousGaps: params.previousGaps,
    respostas: params.respostas,
  });

  const raw = await completeJson<unknown>({
    system: CRITIQUE_SYSTEM,
    prompt,
    maxTokens: 8000,
    deadlineMs: STEP_AI_DEADLINE_MS,
  });

  return normalizeGaps(raw);
}

export interface CompareParams {
  discovery: string;
  prototype: string;
  previousGaps?: Gap[];
  respostas?: Record<string, string>;
}

/**
 * Compara o Discovery COMPLETO com o Protótipo numa ÚNICA chamada — evita os
 * falsos positivos de "tela_sem_discovery" que surgiam quando cada chunk via só
 * uma fatia do Discovery.
 */
export async function compareDiscoveryPrototype(
  params: CompareParams
): Promise<Gap[]> {
  const discovery = truncate(params.discovery, MAX_FULL_DISCOVERY_CHARS);
  const prototype = cappedPrototype(params.prototype) ?? "";

  const prompt = buildComparePrompt({
    discovery,
    prototype,
    previousGaps: params.previousGaps,
    respostas: params.respostas,
  });

  // Observabilidade: contagem REAL de tokens da chamada grande (não bloqueia).
  const real = await countTokens({ system: COMPARE_SYSTEM, prompt });
  if (real != null) {
    console.log(`[compare] input real ≈ ${real} tokens (estimativa ${estimateTokens(prompt)}).`);
  }

  const raw = await completeJson<unknown>({
    system: COMPARE_SYSTEM,
    prompt,
    maxTokens: 8000,
    deadlineMs: STEP_AI_DEADLINE_MS,
  });

  return normalizeGaps(raw);
}

export interface SpecDocGenParams {
  kind: SpecDocKind;
  discovery: string;
  prototype?: string | null;
  gaps: Gap[];
  respostas?: Record<string, string>;
  prd?: string | null;
  productName?: string;
}

/**
 * Gera UM documento do Pacote de Specs (requirements, architecture, etc.).
 * Cada documento é uma chamada de IA independente, sob o mesmo orçamento de
 * tempo dos demais passos para caber no teto serverless.
 */
export async function generateSpecDoc(params: SpecDocGenParams): Promise<string> {
  const meta = SPEC_DOCS[params.kind];
  let discoveryLimit = MAX_FULL_DISCOVERY_CHARS;
  if (meta.needsPrototype) {
    discoveryLimit = MAX_PROTOTYPE_FOCUSED_DISCOVERY_CHARS;
  } else if (params.prd?.trim()) {
    discoveryLimit = MAX_SPEC_DOC_DISCOVERY_CHARS;
  }

  const prototypeLimit =
    params.kind === "design_system"
      ? MAX_DESIGN_SYSTEM_PROTOTYPE_CHARS
      : MAX_PROTOTYPE_CHARS;

  const prompt = buildSpecDocPrompt({
    kind: params.kind,
    discovery: truncate(params.discovery, discoveryLimit),
    prototype: cappedPrototype(params.prototype, prototypeLimit),
    gaps: params.gaps,
    respostas: params.respostas,
    prd: params.prd ? truncate(params.prd, 60_000) : null,
    productName: params.productName,
  });

  return completeText({
    system: SPEC_DOCS[params.kind].system ?? SPEC_DOC_SYSTEM,
    prompt,
    maxTokens: 8000,
    deadlineMs: SPEC_DOC_AI_DEADLINE_MS,
  });
}
