import "dotenv/config";
import cors from "cors";
import express from "express";
import { AnthropicError, completeJson, completeText } from "./anthropic-client";
import { fetchFigmaComments, fetchFigmaFile } from "./figma-client";
import { diffGaps, normalizeGaps } from "./gaps";
import { parseFigJamDocument } from "./parse-figjam";
import { parseFileKey } from "./parse-url";
import {
  buildCritiquePrompt,
  buildPrdPrompt,
  CRITIQUE_SYSTEM,
  PRD_SYSTEM,
} from "./prompts";
import {
  AnalyzeRequest,
  AnalyzeResponse,
  ExportResponse,
  FigmaApiError,
  Gap,
  ParseUrlError,
  PrdRequest,
  PrdResponse,
} from "./types";

const app = express();
const PORT = process.env.PORT ?? 3001;

// Estimativa conservadora de tokens (~3,5 chars/token em pt-BR).
const CHARS_PER_TOKEN = 3.5;
// Orçamento de entrada por chamada, com folga sob o limite de 200k tokens
// para o system prompt, o contexto de respostas e a saída.
const MAX_DISCOVERY_TOKENS = 120_000;
const MAX_DISCOVERY_CHARS = Math.floor(MAX_DISCOVERY_TOKENS * CHARS_PER_TOKEN);

/**
 * Quebra o Discovery em pedaços sob o orçamento, preferindo cortar nos
 * cabeçalhos de seção ("## "). Cada pedaço é criticado separadamente e os
 * gaps são fundidos por ID estável.
 */
function chunkDiscovery(text: string, maxChars: number): string[] {
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
      // Corta numa fronteira de seção quando já passamos de 60% do orçamento.
      flush();
    }

    current.push(line);
    currentLen += lineLen;
  }

  flush();
  return chunks;
}

/** Trunca o Discovery preservando o início, com um marcador explícito. */
function truncateDiscovery(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return (
    text.slice(0, maxChars) +
    "\n\n[... Discovery truncado por limite de tamanho — seções finais omitidas ...]"
  );
}

app.use(cors());
app.use(express.json({ limit: "25mb" }));

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

app.post("/api/export", async (req, res) => {
  const token = process.env.FIGMA_TOKEN;

  if (!token) {
    res.status(500).json({
      error: "FIGMA_TOKEN não configurado. Copie .env.example para .env e defina seu token.",
    });
    return;
  }

  const { url } = req.body as { url?: string };

  if (!url || typeof url !== "string") {
    res.status(400).json({ error: "Campo 'url' é obrigatório." });
    return;
  }

  let fileKey: string;

  try {
    fileKey = parseFileKey(url);
  } catch (error) {
    if (error instanceof ParseUrlError) {
      res.status(400).json({ error: error.message });
      return;
    }
    throw error;
  }

  try {
    const [file, commentsResponse] = await Promise.all([
      fetchFigmaFile(fileKey, token),
      fetchFigmaComments(fileKey, token).catch(() => ({ comments: [] })),
    ]);

    const parsed = parseFigJamDocument(
      file.document,
      commentsResponse.comments
    );

    const response: ExportResponse = {
      metadata: {
        name: file.name,
        lastModified: file.lastModified,
        editorType: file.editorType,
        fileKey,
        version: file.version,
      },
      parsed,
      raw: file,
    };

    res.json(response);
  } catch (error) {
    if (error instanceof FigmaApiError) {
      const status =
        error.statusCode === 403
          ? 403
          : error.statusCode === 404
            ? 404
            : 502;

      res.status(status).json({ error: error.message });
      return;
    }

    console.error("Erro inesperado:", error);
    res.status(500).json({ error: "Erro interno ao processar a exportação." });
  }
});

app.post("/api/analyze", async (req, res) => {
  const { discovery, gaps: previousGaps, respostas } =
    req.body as AnalyzeRequest;

  if (!discovery || typeof discovery !== "string" || !discovery.trim()) {
    res.status(400).json({ error: "Campo 'discovery' é obrigatório." });
    return;
  }

  const isReprocess = Array.isArray(previousGaps) && previousGaps.length > 0;

  try {
    const chunks = chunkDiscovery(discovery, MAX_DISCOVERY_CHARS);
    const rawCollected: unknown[] = [];

    for (const chunk of chunks) {
      const prompt = buildCritiquePrompt(
        chunk,
        isReprocess ? previousGaps : undefined,
        respostas
      );

      const rawGaps = await completeJson<unknown>({
        system: CRITIQUE_SYSTEM,
        prompt,
        maxTokens: 16000,
      });

      if (Array.isArray(rawGaps)) {
        rawCollected.push(...rawGaps);
      }
    }

    // normalizeGaps deduplica por ID estável, fundindo gaps repetidos entre chunks.
    const gaps: Gap[] = normalizeGaps(rawCollected);

    const response: AnalyzeResponse = isReprocess
      ? { gaps, diff: diffGaps(previousGaps as Gap[], gaps) }
      : { gaps };

    res.json(response);
  } catch (error) {
    if (error instanceof AnthropicError) {
      res.status(502).json({ error: error.message });
      return;
    }
    console.error("Erro na análise:", error);
    res.status(500).json({ error: "Erro interno ao analisar o Discovery." });
  }
});

app.post("/api/prd", async (req, res) => {
  const { discovery, gaps, respostas, boardName } = req.body as PrdRequest;

  if (!discovery || typeof discovery !== "string" || !discovery.trim()) {
    res.status(400).json({ error: "Campo 'discovery' é obrigatório." });
    return;
  }

  const safeGaps = Array.isArray(gaps) ? gaps : [];

  const bloqueantes = safeGaps.filter(
    (g) => g.severidade === "alta" && g.status !== "resolvido"
  );

  if (bloqueantes.length > 0) {
    res.status(409).json({
      error: `Existem ${bloqueantes.length} gap(s) de severidade alta em aberto. Resolva-os antes de gerar o PRD.`,
    });
    return;
  }

  try {
    // O PRD precisa do contexto inteiro de uma vez; se exceder, trunca com marcador.
    const prdDiscovery = truncateDiscovery(discovery, MAX_DISCOVERY_CHARS);
    const prompt = buildPrdPrompt(prdDiscovery, safeGaps, respostas, boardName);

    const prd = await completeText({
      system: PRD_SYSTEM,
      prompt,
      maxTokens: 8000,
    });

    const response: PrdResponse = { prd };
    res.json(response);
  } catch (error) {
    if (error instanceof AnthropicError) {
      res.status(502).json({ error: error.message });
      return;
    }
    console.error("Erro na geração do PRD:", error);
    res.status(500).json({ error: "Erro interno ao gerar o PRD." });
  }
});

// Na Vercel o app roda como serverless function (sem servidor persistente).
// Localmente, sobe o servidor HTTP normalmente.
if (!process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

export default app;
