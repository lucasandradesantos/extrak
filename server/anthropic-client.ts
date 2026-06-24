import Anthropic from "@anthropic-ai/sdk";
import { ANTHROPIC_KEY_SETTING, getSetting } from "./settings";

const DEFAULT_MODEL = "claude-sonnet-4-5-20250929";
const CREDIT_PROBE_CACHE_MS = 5 * 60 * 1000;

export type AnthropicErrorCode = "credits_low" | "auth" | "rate_limit" | "generic";

export class AnthropicError extends Error {
  code: AnthropicErrorCode;

  constructor(message: string, code: AnthropicErrorCode = "generic") {
    super(message);
    this.name = "AnthropicError";
    this.code = code;
  }
}

export const CREDITS_LOW_MESSAGE =
  "A conta está sem créditos para gerar análises com IA. Recarregue em console.anthropic.com/settings/billing ou peça ajuda ao administrador.";

function extractApiErrorDetail(error: InstanceType<typeof Anthropic.APIError>): string {
  return (
    (error.error as { error?: { message?: string } })?.error?.message ??
    error.message
  );
}

function humanizeAnthropicDetail(
  status: number,
  detail: string
): { message: string; code: AnthropicErrorCode } {
  const lower = detail.toLowerCase();

  if (
    status === 400 &&
    (lower.includes("credit balance is too low") ||
      lower.includes("insufficient credits"))
  ) {
    return { message: CREDITS_LOW_MESSAGE, code: "credits_low" };
  }

  if (
    status === 401 ||
    lower.includes("invalid api key") ||
    lower.includes("authentication")
  ) {
    return {
      message:
        "Chave da API Anthropic inválida ou expirada. Verifique a configuração no Admin.",
      code: "auth",
    };
  }

  if (status === 429 || lower.includes("rate limit") || lower.includes("rate_limit")) {
    return {
      message:
        "Limite de uso da API Anthropic atingido. Aguarde alguns minutos e tente novamente.",
      code: "rate_limit",
    };
  }

  return {
    message: `Erro da API Anthropic (${status}): ${detail}`,
    code: "generic",
  };
}

let creditProbeCache: { at: number; ok: boolean; message?: string } | null = null;

/**
 * Verifica levemente se a chave da Anthropic consegue usar a API (cache de 5 min).
 * Não expõe saldo em dólares — a Anthropic não oferece endpoint oficial para isso.
 */
export async function probeAnthropicCredits(): Promise<{
  ok: boolean;
  message?: string;
}> {
  if (
    creditProbeCache &&
    Date.now() - creditProbeCache.at < CREDIT_PROBE_CACHE_MS
  ) {
    return { ok: creditProbeCache.ok, message: creditProbeCache.message };
  }

  try {
    const client = await getClient();
    await client.messages.countTokens({
      model: getModel(),
      messages: [{ role: "user", content: "ping" }],
    });
    creditProbeCache = { at: Date.now(), ok: true };
    return { ok: true };
  } catch (error) {
    if (error instanceof Anthropic.APIError) {
      const { message, code } = humanizeAnthropicDetail(
        error.status,
        extractApiErrorDetail(error)
      );
      if (code === "credits_low") {
        creditProbeCache = { at: Date.now(), ok: false, message };
        return { ok: false, message };
      }
    }

    if (error instanceof AnthropicError) {
      if (error.code === "credits_low") {
        creditProbeCache = { at: Date.now(), ok: false, message: error.message };
        return { ok: false, message: error.message };
      }
      if (error.message.includes("não configurada")) {
        return { ok: true };
      }
    }

    creditProbeCache = { at: Date.now(), ok: true };
    return { ok: true };
  }
}

/**
 * Resolve a chave da API: prioriza a configurada no Admin (banco) e cai para a
 * variável de ambiente. Lança se nenhuma estiver disponível.
 */
export async function resolveAnthropicKey(): Promise<string> {
  let apiKey: string | null = null;
  try {
    apiKey = await getSetting(ANTHROPIC_KEY_SETTING);
  } catch {
    // Falha ao ler do banco não deve impedir o fallback para a env.
  }

  const resolved = (apiKey && apiKey.trim()) || process.env.ANTHROPIC_API_KEY;

  if (!resolved || resolved === "sua_chave_anthropic_aqui") {
    throw new AnthropicError(
      "Chave da API do Claude não configurada. Defina-a no Admin ou no arquivo .env."
    );
  }

  return resolved;
}

async function getClient(): Promise<Anthropic> {
  return new Anthropic({ apiKey: await resolveAnthropicKey() });
}

function getModel(): string {
  return process.env.ANTHROPIC_MODEL?.trim() || DEFAULT_MODEL;
}

interface CompletionOptions {
  system: string;
  prompt: string;
  maxTokens?: number;
  /**
   * Orçamento de tempo (ms) para a geração. Ao atingir o limite, a geração é
   * interrompida e a saída PARCIAL já recebida é aproveitada. Essencial em
   * ambientes serverless com teto curto (ex.: Vercel Hobby = 60s): garante que
   * o passo sempre conclua e grave progresso, em vez de ser morto no meio.
   */
  deadlineMs?: number;
}

async function complete({
  system,
  prompt,
  maxTokens = 8000,
  deadlineMs,
}: CompletionOptions): Promise<string> {
  const client = await getClient();

  const controller = new AbortController();
  let timedOut = false;
  const timer =
    deadlineMs && deadlineMs > 0
      ? setTimeout(() => {
          timedOut = true;
          controller.abort();
        }, deadlineMs)
      : null;

  let text = "";
  try {
    // Streaming: mantém a conexão viva e permite abortar no deadline mantendo o
    // que já foi gerado (o parser recupera JSON parcial).
    const stream = client.messages.stream(
      {
        model: getModel(),
        max_tokens: maxTokens,
        system,
        messages: [{ role: "user", content: prompt }],
      },
      { signal: controller.signal }
    );

    for await (const event of stream) {
      if (
        event.type === "content_block_delta" &&
        event.delta.type === "text_delta"
      ) {
        text += event.delta.text;
      }
    }
  } catch (error) {
    const isAbort =
      timedOut ||
      (error instanceof Error &&
        (error.name === "AbortError" ||
          error.name === "APIUserAbortError" ||
          /abort/i.test(error.message)));

    if (isAbort) {
      console.warn(
        `[anthropic] Geração interrompida no limite de ${deadlineMs}ms; ` +
          `usando saída parcial (${text.length} chars).`
      );
    } else if (error instanceof Anthropic.APIError) {
      const { message, code } = humanizeAnthropicDetail(
        error.status,
        extractApiErrorDetail(error)
      );
      if (code === "credits_low") {
        creditProbeCache = { at: Date.now(), ok: false, message };
      }
      throw new AnthropicError(message, code);
    } else {
      throw error;
    }
  } finally {
    if (timer) clearTimeout(timer);
  }

  text = text.trim();

  if (!text) {
    throw new AnthropicError(
      timedOut
        ? "A IA não retornou conteúdo dentro do tempo disponível."
        : "A IA retornou uma resposta vazia."
    );
  }

  return text;
}

export async function completeText(
  options: CompletionOptions
): Promise<string> {
  return complete(options);
}

/**
 * Contagem REAL de tokens do input via API da Anthropic (endpoint count_tokens).
 * Retorna null se a contagem falhar — é usada apenas para observabilidade e
 * NUNCA deve bloquear a geração.
 */
export async function countTokens(options: {
  system: string;
  prompt: string;
}): Promise<number | null> {
  try {
    const client = await getClient();
    const result = await client.messages.countTokens({
      model: getModel(),
      system: options.system,
      messages: [{ role: "user", content: options.prompt }],
    });
    return result.input_tokens;
  } catch {
    return null;
  }
}

/**
 * Recupera os objetos completos de um array JSON mesmo que a resposta tenha
 * sido truncada (ex.: estouro de max_tokens). Faz casamento de chaves
 * ignorando chaves dentro de strings, e descarta o último objeto incompleto.
 */
function salvageObjectArray(text: string): unknown[] | null {
  const start = text.indexOf("[");
  if (start === -1) return null;

  const objects: unknown[] = [];
  let depth = 0;
  let objStart = -1;
  let inString = false;
  let escaped = false;

  for (let i = start + 1; i < text.length; i++) {
    const ch = text[i];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
    } else if (ch === "{") {
      if (depth === 0) objStart = i;
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0 && objStart !== -1) {
        const slice = text.slice(objStart, i + 1);
        try {
          objects.push(JSON.parse(slice));
        } catch {
          // objeto malformado: ignora e segue
        }
        objStart = -1;
      }
    }
  }

  return objects.length > 0 ? objects : null;
}

/**
 * Extrai um array/objeto JSON de uma resposta da IA, tolerando cercas de código
 * (```json ... ```), texto adicional e respostas truncadas.
 */
function extractJson(raw: string): unknown {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = (fenced ? fenced[1] : raw).trim();

  try {
    return JSON.parse(candidate);
  } catch {
    // Tenta recortar do primeiro [ ou { até o último ] ou } correspondente.
    const firstBracket = candidate.search(/[[{]/);
    const lastBracket = Math.max(
      candidate.lastIndexOf("]"),
      candidate.lastIndexOf("}")
    );

    if (firstBracket !== -1 && lastBracket > firstBracket) {
      const sliced = candidate.slice(firstBracket, lastBracket + 1);
      try {
        return JSON.parse(sliced);
      } catch {
        // cai para o salvamento abaixo
      }
    }

    // Última tentativa: recuperar objetos completos de um array truncado.
    const salvaged = salvageObjectArray(candidate);
    if (salvaged) {
      console.warn(
        `[anthropic] JSON recuperado parcialmente: ${salvaged.length} objeto(s) válido(s) de resposta possivelmente truncada.`
      );
      return salvaged;
    }

    console.error(
      "[anthropic] Falha ao interpretar JSON. Resposta (primeiros 800 chars):\n" +
        candidate.slice(0, 800)
    );
    throw new AnthropicError(
      "Não foi possível interpretar o JSON retornado pela IA."
    );
  }
}

export async function completeJson<T = unknown>(
  options: CompletionOptions
): Promise<T> {
  const raw = await complete(options);
  return extractJson(raw) as T;
}
