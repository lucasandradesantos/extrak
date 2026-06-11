import { ParseUrlError } from "./types";

const FIGMA_URL_REGEX = /figma\.com\/(board|design|file)\/([^/?]+)/i;
const FILE_KEY_REGEX = /^[a-zA-Z0-9]{10,30}$/;

export function parseFileKey(input: string): string {
  const trimmed = input.trim();

  if (!trimmed) {
    throw new ParseUrlError("URL ou file key não pode estar vazio.");
  }

  const urlMatch = trimmed.match(FIGMA_URL_REGEX);
  if (urlMatch) {
    return urlMatch[2];
  }

  if (FILE_KEY_REGEX.test(trimmed)) {
    return trimmed;
  }

  throw new ParseUrlError(
    "URL inválida. Use uma URL do FigJam (ex: https://www.figma.com/board/...) ou a file key diretamente."
  );
}
