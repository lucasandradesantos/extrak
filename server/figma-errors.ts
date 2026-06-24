/** Mensagens amigáveis para erros conhecidos da API REST do Figma. */
export function humanizeFigmaApiError(message: string): string {
  if (!message) return message;

  const lower = message.toLowerCase();

  if (lower.includes("file not exportable")) {
    return (
      "Não foi possível extrair este arquivo do Figma: a exportação está bloqueada. " +
      "Peça ao responsável pelo arquivo para compartilhá-lo com a conta do token Figma usada pelo Extrak " +
      'e, em Share → Advanced, ativar "Viewers can copy, share, and export from this file".'
    );
  }

  if (lower.includes("invalid token")) {
    return (
      "Token do Figma inválido ou expirado. Gere um novo Personal Access Token em " +
      "figma.com/settings e atualize FIGMA_TOKEN no servidor."
    );
  }

  if (lower.includes("not found") || lower.includes("file not found")) {
    return (
      "Arquivo Figma não encontrado. Verifique se a URL está correta e se o arquivo " +
      "não foi excluído ou movido."
    );
  }

  if (lower.includes("rate limit") || lower.includes("too many requests")) {
    return "Limite de requisições da API Figma atingido. Aguarde alguns minutos e tente novamente.";
  }

  if (lower.startsWith("erro na api figma")) {
    return message.replace(/^Erro na API Figma/i, "Erro na API do Figma");
  }

  return message;
}
