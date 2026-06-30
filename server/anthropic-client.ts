import Anthropic from "@anthropic-ai/sdk";
import { ANTHROPIC_KEY_SETTING, getSetting } from "./settings";
import { getSupabaseAdmin } from "./supabase";
import { getUsageContext } from "./usage-context";

const DEFAULT_MODEL = "claude-sonnet-4-5-20250929";

// Preço por 1M de tokens (USD). ESTIMATIVA — ajuste conforme o faturamento real
// da Anthropic. Usado só para exibir custo aproximado; os tokens são a verdade.
const PRICING: Record<
  string,
  { input: number; output: number; cacheWrite: number; cacheRead: number }
> = {
  "claude-opus": { input: 15, output: 75, cacheWrite: 18.75, cacheRead: 1.5 },
  "claude-sonnet": { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
  "claude-haiku": { input: 0.8, output: 4, cacheWrite: 1, cacheRead: 0.08 },
};
const DEFAULT_PRICING = PRICING["claude-sonnet"];

function priceFor(model: string) {
  const key = Object.keys(PRICING).find((k) => model.includes(k));
  return key ? PRICING[key] : DEFAULT_PRICING;
}

interface TokenUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
}

/**
 * Registra o consumo de tokens da chamada no banco, atribuído ao projeto/feature
 * do contexto atual. Best-effort: nunca lança nem bloqueia a geração.
 */
async function recordUsage(model: string, usage: TokenUsage | null | undefined): Promise<void> {
  if (!usage) return;
  const ctx = getUsageContext();
  if (!ctx) return; // sem contexto (ex.: probe de créditos) → não registra

  const input = usage.input_tokens ?? 0;
  const output = usage.output_tokens ?? 0;
  const cacheWrite = usage.cache_creation_input_tokens ?? 0;
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  if (input === 0 && output === 0 && cacheWrite === 0 && cacheRead === 0) return;

  const p = priceFor(model);
  const cost =
    (input * p.input + output * p.output + cacheWrite * p.cacheWrite + cacheRead * p.cacheRead) /
    1_000_000;

  try {
    const admin = getSupabaseAdmin();
    await admin.from("token_usage").insert({
      project_id: ctx.projectId ?? null,
      feature: ctx.feature,
      model,
      input_tokens: input,
      output_tokens: output,
      cache_creation_input_tokens: cacheWrite,
      cache_read_input_tokens: cacheRead,
      cost_usd: Number(cost.toFixed(6)),
      created_by: ctx.userId ?? null,
    });
  } catch (err) {
    console.error("[usage] falha ao registrar consumo de tokens:", err);
  }
}
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
  const usage: TokenUsage = {};
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
      if (event.type === "message_start") {
        usage.input_tokens = event.message.usage.input_tokens;
        usage.cache_creation_input_tokens = event.message.usage.cache_creation_input_tokens;
        usage.cache_read_input_tokens = event.message.usage.cache_read_input_tokens;
      } else if (event.type === "message_delta") {
        usage.output_tokens = event.usage.output_tokens;
      } else if (
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
    // Registra o consumo mesmo em abort/erro — os tokens já foram cobrados.
    await recordUsage(getModel(), usage);
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

interface ToolJsonOptions {
  system: string;
  prompt: string;
  toolName: string;
  toolDescription: string;
  inputSchema: Record<string, unknown>;
  maxTokens?: number;
  deadlineMs?: number;
}

/**
 * Saída estruturada via tool-use: força a IA a chamar uma ferramenta com um
 * schema, devolvendo o `input` já como objeto JS — sem parsear texto livre
 * (elimina o erro "não foi possível interpretar o JSON"). Não usa streaming;
 * com saída limitada cabe bem no tempo da função.
 */
export async function completeJsonViaTool<T = unknown>(
  options: ToolJsonOptions
): Promise<T> {
  const client = await getClient();
  const controller = new AbortController();
  let timedOut = false;
  const timer =
    options.deadlineMs && options.deadlineMs > 0
      ? setTimeout(() => {
          timedOut = true;
          controller.abort();
        }, options.deadlineMs)
      : null;

  try {
    const response = await client.messages.create(
      {
        model: getModel(),
        max_tokens: options.maxTokens ?? 8000,
        system: options.system,
        messages: [{ role: "user", content: options.prompt }],
        tools: [
          {
            name: options.toolName,
            description: options.toolDescription,
            input_schema: options.inputSchema as Anthropic.Tool.InputSchema,
          },
        ],
        tool_choice: { type: "tool", name: options.toolName },
      },
      { signal: controller.signal }
    );

    await recordUsage(getModel(), response.usage);

    const block = response.content.find((b) => b.type === "tool_use");
    if (!block || block.type !== "tool_use") {
      throw new AnthropicError("A IA não retornou a estrutura esperada.");
    }
    return block.input as T;
  } catch (error) {
    if (error instanceof AnthropicError) throw error;

    if (
      timedOut ||
      (error instanceof Error &&
        (error.name === "AbortError" ||
          error.name === "APIUserAbortError" ||
          /abort/i.test(error.message)))
    ) {
      throw new AnthropicError(
        `A IA não respondeu dentro de ${options.deadlineMs}ms.`
      );
    }

    if (error instanceof Anthropic.APIError) {
      const { message, code } = humanizeAnthropicDetail(
        error.status,
        extractApiErrorDetail(error)
      );
      if (code === "credits_low") {
        creditProbeCache = { at: Date.now(), ok: false, message };
      }
      throw new AnthropicError(message, code);
    }

    throw error;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
