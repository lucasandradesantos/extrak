import { completeJson, completeText, countTokens } from "./anthropic-client";
import { normalizeGaps } from "./gaps";
import {
  COMPARE_SYSTEM,
  CRITIQUE_SYSTEM,
  PRD_SYSTEM,
  buildComparePrompt,
  buildCritiquePrompt,
  buildPrdPrompt,
} from "./prompts";
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
const MAX_PROTOTYPE_CHARS = 50_000;
// PRD e comparação recebem o Discovery COMPLETO; o teto só evita estourar a
// janela de contexto do modelo (~200k tokens) em casos extremos.
export const MAX_FULL_DISCOVERY_CHARS = 320_000;

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
export function cappedPrototype(prototype: string | null | undefined): string | null {
  if (!prototype || !prototype.trim()) return null;
  if (prototype.length <= MAX_PROTOTYPE_CHARS) return prototype;

  const marker = "### Tela:";
  const totalScreens = prototype.split(marker).length - 1;

  // Mantém o cabeçalho/preâmbulo + o máximo de blocos de tela que couberem.
  const firstScreen = prototype.indexOf(marker);
  if (firstScreen === -1 || firstScreen > MAX_PROTOTYPE_CHARS) {
    return truncate(prototype, MAX_PROTOTYPE_CHARS);
  }

  let cut = firstScreen;
  let included = 0;
  let searchFrom = firstScreen;
  while (true) {
    const next = prototype.indexOf(marker, searchFrom + marker.length);
    const blockEnd = next === -1 ? prototype.length : next;
    if (blockEnd > MAX_PROTOTYPE_CHARS) break;
    cut = blockEnd;
    included += 1;
    if (next === -1) break;
    searchFrom = next;
  }

  if (included === 0) {
    // Nem uma tela inteira coube: cai para o corte cego, mas avisa.
    return (
      truncate(prototype, MAX_PROTOTYPE_CHARS) +
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
    maxTokens: 16000,
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
    maxTokens: 16000,
  });

  return normalizeGaps(raw);
}

export interface PrdGenParams {
  discovery: string;
  prototype?: string | null;
  gaps: Gap[];
  respostas?: Record<string, string>;
  productName?: string;
}

export async function generatePrd(params: PrdGenParams): Promise<string> {
  // O PRD usa o Discovery COMPLETO (antes truncava em 1 chunk e perdia conteúdo).
  // O teto MAX_FULL_DISCOVERY_CHARS só protege a janela de contexto em extremos.
  const prompt = buildPrdPrompt({
    discovery: truncate(params.discovery, MAX_FULL_DISCOVERY_CHARS),
    prototype: cappedPrototype(params.prototype),
    gaps: params.gaps,
    respostas: params.respostas,
    productName: params.productName,
  });

  const real = await countTokens({ system: PRD_SYSTEM, prompt });
  if (real != null) {
    console.log(`[prd] input real ≈ ${real} tokens (estimativa ${estimateTokens(prompt)}).`);
  }

  return completeText({ system: PRD_SYSTEM, prompt, maxTokens: 8000 });
}
