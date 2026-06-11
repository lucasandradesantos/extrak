import Anthropic from "@anthropic-ai/sdk";

const DEFAULT_MODEL = "claude-sonnet-4-5-20250929";

export class AnthropicError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AnthropicError";
  }
}

function getClient(): Anthropic {
  const apiKey = process.env.ANTHROPIC_API_KEY;

  if (!apiKey || apiKey === "sua_chave_anthropic_aqui") {
    throw new AnthropicError(
      "ANTHROPIC_API_KEY não configurado. Defina sua chave no arquivo .env."
    );
  }

  return new Anthropic({ apiKey });
}

function getModel(): string {
  return process.env.ANTHROPIC_MODEL?.trim() || DEFAULT_MODEL;
}

interface CompletionOptions {
  system: string;
  prompt: string;
  maxTokens?: number;
}

async function complete({
  system,
  prompt,
  maxTokens = 8000,
}: CompletionOptions): Promise<string> {
  const client = getClient();

  let response: Anthropic.Message;
  try {
    response = await client.messages.create({
      model: getModel(),
      max_tokens: maxTokens,
      system,
      messages: [{ role: "user", content: prompt }],
    });
  } catch (error) {
    if (error instanceof Anthropic.APIError) {
      const detail =
        (error.error as { error?: { message?: string } })?.error?.message ??
        error.message;
      throw new AnthropicError(`Erro da API Anthropic (${error.status}): ${detail}`);
    }
    throw error;
  }

  const text = response.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();

  if (!text) {
    throw new AnthropicError("A IA retornou uma resposta vazia.");
  }

  return text;
}

export async function completeText(
  options: CompletionOptions
): Promise<string> {
  return complete(options);
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
