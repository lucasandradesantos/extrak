import { supabase } from "./supabase";
import { humanizeApiError } from "./humanizeApiError";

/**
 * Lê a resposta tolerando corpos não-JSON (páginas de erro 5xx da Vercel) e
 * mensagens de timeout, evitando o confuso "Unexpected token".
 */
async function readApiJson<T>(response: Response, fallbackMessage: string): Promise<T> {
  const text = await response.text();

  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }

  if (!response.ok) {
    const apiError =
      data && typeof data === "object" && "error" in data
        ? String((data as { error: unknown }).error)
        : null;

    if (response.status === 504 || /FUNCTION_INVOCATION_TIMEOUT/i.test(text)) {
      throw new Error(
        "A operação excedeu o limite de tempo do servidor (timeout). Tente novamente."
      );
    }

    throw new Error(humanizeApiError(apiError ?? fallbackMessage));
  }

  if (data === null) {
    throw new Error(fallbackMessage);
  }

  return data as T;
}

/** Faz uma chamada à API anexando o token de sessão do Supabase. */
export async function apiFetch<T>(
  path: string,
  options: { method?: string; body?: unknown; fallback?: string } = {}
): Promise<T> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  const response = await fetch(path, {
    method: options.method ?? "GET",
    headers,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });

  return readApiJson<T>(response, options.fallback ?? "Erro na requisição.");
}
