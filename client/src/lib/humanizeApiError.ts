const CREDITS_LOW_PATTERNS = [
  "credit balance is too low",
  "insufficient credits",
  "sem créditos para gerar análises com ia",
];

export const CREDITS_LOW_MESSAGE =
  "A conta está sem créditos para gerar análises com IA. Recarregue em console.anthropic.com/settings/billing ou peça ajuda ao administrador.";

export function isCreditsLowError(message: string): boolean {
  const lower = message.toLowerCase();
  return CREDITS_LOW_PATTERNS.some((pattern) => lower.includes(pattern));
}

/** Traduz mensagens conhecidas da API para português (inclui erros antigos já salvos). */
export function humanizeApiError(message: string): string {
  if (!message) return message;

  if (isCreditsLowError(message)) {
    return CREDITS_LOW_MESSAGE;
  }

  const lower = message.toLowerCase();

  if (lower.includes("invalid api key") || lower.includes("authentication")) {
    return "Chave da API Anthropic inválida ou expirada. Verifique a configuração no Admin.";
  }

  if (lower.includes("rate limit") || lower.includes("rate_limit")) {
    return "Limite de uso da API Anthropic atingido. Aguarde alguns minutos e tente novamente.";
  }

  return message;
}
