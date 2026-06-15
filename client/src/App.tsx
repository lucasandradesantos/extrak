import { useMemo, useState } from "react";
import type {
  AnalyzeResponse,
  ExportResponse,
  Gap,
  GapDiff,
  GapSeveridade,
  ParsedItem,
  PrdResponse,
} from "./types";

type Tab = "parsed" | "raw" | "analise" | "prd";

const TYPE_LABELS: Record<string, string> = {
  STICKY: "Sticky Notes",
  SHAPE_WITH_TEXT: "Shapes com Texto",
  CONNECTOR: "Conectores",
  TEXT: "Textos",
  SECTION: "Seções",
  TABLE: "Tabelas",
  TABLE_CELL: "Células de Tabela",
  WIDGET: "Widgets",
};

const CATEGORIA_LABELS: Record<string, string> = {
  cobertura: "Cobertura",
  metrica_sem_meta: "Métrica sem meta",
  persona_faltante: "Persona faltante",
  inconsistencia: "Inconsistência",
  criterio_nao_testavel: "Critério não testável",
  pergunta_cliente: "Pergunta para o cliente",
};

const SEVERIDADE_ORDER: GapSeveridade[] = ["alta", "media", "baixa"];

const SEVERIDADE_LABELS: Record<GapSeveridade, string> = {
  alta: "Alta",
  media: "Média",
  baixa: "Baixa",
};

/**
 * Lê a resposta da API tolerando corpos não-JSON (ex.: páginas de erro 5xx da
 * Vercel) e mensagens de timeout, evitando o confuso "Unexpected token".
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
        "A análise demorou demais e excedeu o limite de tempo do servidor (timeout). " +
          "Boards muito grandes podem ultrapassar o limite da função serverless. Tente novamente " +
          "ou reduza o tamanho do board."
      );
    }

    throw new Error(apiError ?? fallbackMessage);
  }

  if (data === null) {
    throw new Error(fallbackMessage);
  }

  return data as T;
}

function groupItemsByType(items: ParsedItem[]): Map<string, ParsedItem[]> {
  const grouped = new Map<string, ParsedItem[]>();

  for (const item of items) {
    const list = grouped.get(item.type) ?? [];
    list.push(item);
    grouped.set(item.type, list);
  }

  return grouped;
}

function formatParsedAsText(data: ExportResponse): string {
  const lines: string[] = [];
  const grouped = groupItemsByType(data.parsed.items);

  for (const [type, items] of grouped) {
    lines.push(`## ${TYPE_LABELS[type] ?? type} (${items.length})`);
    lines.push("");

    for (const item of items) {
      const location =
        item.path.length > 0 ? ` [${item.path.join(" > ")}]` : "";
      lines.push(`- ${item.name} (${item.id})${location}`);

      if (item.text) {
        lines.push(`  ${item.text.replace(/\n/g, "\n  ")}`);
      }

      if (item.shapeType) {
        lines.push(`  Shape: ${item.shapeType}`);
      }

      if (item.connectorStart || item.connectorEnd) {
        const start = item.connectorStart?.endpointNodeId ?? "—";
        const end = item.connectorEnd?.endpointNodeId ?? "—";
        lines.push(`  Conexão: ${start} → ${end}`);
      }

      lines.push("");
    }
  }

  if (data.parsed.comments.length > 0) {
    lines.push(`## Comentários (${data.parsed.comments.length})`);
    lines.push("");

    for (const comment of data.parsed.comments) {
      lines.push(
        `- ${comment.user} (${new Date(comment.created_at).toLocaleString("pt-BR")})`
      );
      lines.push(`  ${comment.message.replace(/\n/g, "\n  ")}`);
      lines.push("");
    }
  }

  return lines.join("\n").trim();
}

/**
 * Texto do nó que tem valor de análise. Descarta o que é puro layout:
 * conectores sem rótulo, seções (já viram cabeçalho via path) e containers.
 */
function meaningfulText(item: ParsedItem): string | null {
  switch (item.type) {
    case "STICKY":
    case "SHAPE_WITH_TEXT":
    case "TEXT":
    case "TABLE_CELL":
    case "WIDGET":
      return item.text?.trim() || null;
    case "CONNECTOR":
      return item.text?.trim() || null;
    default:
      return null;
  }
}

/**
 * Discovery enxuto para a IA (passo 2.5): apenas hierarquia + texto.
 * Sem IDs, posições ou conectores vazios — reduz drasticamente os tokens.
 */
function buildDiscoveryForAI(data: ExportResponse): string {
  const lines: string[] = [`# Discovery: ${data.metadata.name}`];
  let lastPath = "\u0000";

  for (const item of data.parsed.items) {
    const text = meaningfulText(item);
    if (!text) continue;

    const pathKey = item.path.join(" > ");
    if (pathKey !== lastPath) {
      lines.push("", `## ${pathKey || "(sem seção)"}`);
      lastPath = pathKey;
    }
    lines.push(`- ${text.replace(/\s*\n\s*/g, " ")}`);
  }

  if (data.parsed.comments.length > 0) {
    lines.push("", "## Comentários");
    for (const comment of data.parsed.comments) {
      lines.push(`- ${comment.user}: ${comment.message.replace(/\s*\n\s*/g, " ")}`);
    }
  }

  return lines.join("\n").trim();
}

async function copyToClipboard(text: string): Promise<void> {
  await navigator.clipboard.writeText(text);
}

function downloadJson(data: ExportResponse): void {
  const blob = new Blob([JSON.stringify(data.raw, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${data.metadata.name.replace(/[^a-z0-9-_]+/gi, "_")}.json`;
  anchor.click();
  URL.revokeObjectURL(url);
}

function downloadText(text: string, filename: string): void {
  const blob = new Blob([text], { type: "text/markdown" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

function groupGapsBySeveridade(gaps: Gap[]): Map<GapSeveridade, Gap[]> {
  const grouped = new Map<GapSeveridade, Gap[]>();
  for (const sev of SEVERIDADE_ORDER) {
    const list = gaps.filter((g) => g.severidade === sev);
    if (list.length > 0) grouped.set(sev, list);
  }
  return grouped;
}

export default function App() {
  const [url, setUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ExportResponse | null>(null);
  const [activeTab, setActiveTab] = useState<Tab>("parsed");
  const [copyFeedback, setCopyFeedback] = useState<string | null>(null);

  const [gaps, setGaps] = useState<Gap[]>([]);
  const [respostas, setRespostas] = useState<Record<string, string>>({});
  const [diff, setDiff] = useState<GapDiff | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [analysisError, setAnalysisError] = useState<string | null>(null);
  const [hasAnalyzed, setHasAnalyzed] = useState(false);

  const [prd, setPrd] = useState<string | null>(null);
  const [prdLoading, setPrdLoading] = useState(false);
  const [prdError, setPrdError] = useState<string | null>(null);

  const discovery = useMemo(
    () => (result ? buildDiscoveryForAI(result) : ""),
    [result]
  );

  const blockingGaps = useMemo(
    () => gaps.filter((g) => g.severidade === "alta" && g.status !== "resolvido"),
    [gaps]
  );

  function resetAnalysis() {
    setGaps([]);
    setRespostas({});
    setDiff(null);
    setHasAnalyzed(false);
    setAnalysisError(null);
    setPrd(null);
    setPrdError(null);
  }

  async function handleExport(event: React.FormEvent) {
    event.preventDefault();
    setLoading(true);
    setError(null);
    setCopyFeedback(null);
    resetAnalysis();

    try {
      const response = await fetch("/api/export", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
      });

      const data = await readApiJson<ExportResponse>(
        response,
        "Erro ao exportar o board."
      );

      setResult(data);
      setActiveTab("parsed");
    } catch (err) {
      setResult(null);
      setError(err instanceof Error ? err.message : "Erro desconhecido.");
    } finally {
      setLoading(false);
    }
  }

  async function runAnalyze(reprocess: boolean) {
    if (!result) return;
    setAnalyzing(true);
    setAnalysisError(null);

    try {
      const body = reprocess
        ? { discovery, gaps, respostas }
        : { discovery };

      const response = await fetch("/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      const analysis = await readApiJson<AnalyzeResponse>(
        response,
        "Erro ao analisar o Discovery."
      );
      setGaps(analysis.gaps);
      setDiff(analysis.diff ?? null);
      setHasAnalyzed(true);

      // Mantém respostas apenas dos gaps que ainda existem.
      setRespostas((prev) => {
        const next: Record<string, string> = {};
        for (const gap of analysis.gaps) {
          if (prev[gap.id]) next[gap.id] = prev[gap.id];
        }
        return next;
      });
    } catch (err) {
      setAnalysisError(
        err instanceof Error ? err.message : "Erro desconhecido."
      );
    } finally {
      setAnalyzing(false);
    }
  }

  async function handleGeneratePrd() {
    if (!result) return;
    setPrdLoading(true);
    setPrdError(null);

    try {
      const response = await fetch("/api/prd", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          discovery,
          gaps,
          respostas,
          boardName: result.metadata.name,
        }),
      });

      const data = await readApiJson<PrdResponse>(
        response,
        "Erro ao gerar o PRD."
      );

      setPrd(data.prd);
    } catch (err) {
      setPrdError(err instanceof Error ? err.message : "Erro desconhecido.");
    } finally {
      setPrdLoading(false);
    }
  }

  async function handleCopy(text: string, label: string) {
    await copyToClipboard(text);
    setCopyFeedback(label);
    setTimeout(() => setCopyFeedback(null), 2000);
  }

  const grouped = result ? groupItemsByType(result.parsed.items) : null;
  const rawJson = result ? JSON.stringify(result.raw, null, 2) : "";
  const groupedGaps = groupGapsBySeveridade(gaps);
  const hasRespostas = Object.values(respostas).some((r) => r.trim());

  return (
    <div className="app">
      <header className="header">
        <h1>FigJam → PRD</h1>
        <p>
          Extraia o Discovery de um board FigJam, deixe a IA criticar as
          lacunas e gere um PRD que admite o que ainda não foi definido.
        </p>
      </header>

      <form className="export-form" onSubmit={handleExport}>
        <input
          type="text"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://www.figma.com/board/... ou file key"
          required
        />
        <button className="btn" type="submit" disabled={loading}>
          {loading ? "Extraindo..." : "Extrair"}
        </button>
      </form>

      {error && <div className="error-box">{error}</div>}

      {result && (
        <>
          <div className="metadata">
            <div className="metadata-card">
              <div className="label">Board</div>
              <div className="value">{result.metadata.name}</div>
            </div>
            <div className="metadata-card">
              <div className="label">Tipo</div>
              <div className="value">{result.metadata.editorType}</div>
            </div>
            <div className="metadata-card">
              <div className="label">Modificado em</div>
              <div className="value">
                {new Date(result.metadata.lastModified).toLocaleString("pt-BR")}
              </div>
            </div>
            <div className="metadata-card">
              <div className="label">File Key</div>
              <div className="value">{result.metadata.fileKey}</div>
            </div>
          </div>

          <div className="summary-chips">
            <span className="chip">
              {result.parsed.summary.stickies} stickies
            </span>
            <span className="chip">{result.parsed.summary.shapes} shapes</span>
            <span className="chip">
              {result.parsed.summary.connectors} conectores
            </span>
            <span className="chip">
              {result.parsed.summary.textNodes} textos
            </span>
            <span className="chip">
              {result.parsed.summary.sections} seções
            </span>
            <span className="chip">
              {result.parsed.summary.comments} comentários
            </span>
          </div>

          <div className="tabs">
            <button
              type="button"
              className={`tab ${activeTab === "parsed" ? "active" : ""}`}
              onClick={() => setActiveTab("parsed")}
            >
              Conteúdo extraído
            </button>
            <button
              type="button"
              className={`tab ${activeTab === "raw" ? "active" : ""}`}
              onClick={() => setActiveTab("raw")}
            >
              JSON bruto
            </button>
            <button
              type="button"
              className={`tab ${activeTab === "analise" ? "active" : ""}`}
              onClick={() => setActiveTab("analise")}
            >
              Análise (IA){gaps.length > 0 ? ` · ${gaps.length}` : ""}
            </button>
            <button
              type="button"
              className={`tab ${activeTab === "prd" ? "active" : ""}`}
              onClick={() => setActiveTab("prd")}
            >
              PRD
            </button>
          </div>

          {activeTab === "parsed" && (
            <div className="panel">
              <div className="panel-toolbar">
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() =>
                    handleCopy(formatParsedAsText(result), "Conteúdo copiado")
                  }
                >
                  Copiar tudo
                </button>
                {copyFeedback && (
                  <span className="copy-feedback">{copyFeedback}</span>
                )}
              </div>
              <div className="panel-content">
                {grouped &&
                grouped.size === 0 &&
                result.parsed.comments.length === 0 ? (
                  <div className="empty-state">
                    Nenhum conteúdo textual encontrado neste board.
                  </div>
                ) : (
                  <>
                    {grouped &&
                      Array.from(grouped.entries()).map(([type, items]) => (
                        <section key={type}>
                          <h2 className="group-title">
                            {TYPE_LABELS[type] ?? type} ({items.length})
                          </h2>
                          {items.map((item) => (
                            <article key={item.id} className="item-card">
                              <div className="item-header">
                                <span className="item-name">{item.name}</span>
                                <span className="item-meta">{item.id}</span>
                              </div>
                              {item.path.length > 0 && (
                                <div className="item-meta">
                                  {item.path.join(" > ")}
                                </div>
                              )}
                              {item.text && (
                                <p className="item-text">{item.text}</p>
                              )}
                              {item.shapeType && (
                                <div className="item-meta">
                                  Shape: {item.shapeType}
                                </div>
                              )}
                              {(item.connectorStart || item.connectorEnd) && (
                                <div className="item-meta">
                                  Conexão:{" "}
                                  {item.connectorStart?.endpointNodeId ?? "—"} →{" "}
                                  {item.connectorEnd?.endpointNodeId ?? "—"}
                                </div>
                              )}
                            </article>
                          ))}
                        </section>
                      ))}

                    {result.parsed.comments.length > 0 && (
                      <section>
                        <h2 className="group-title">
                          Comentários ({result.parsed.comments.length})
                        </h2>
                        {result.parsed.comments.map((comment) => (
                          <article key={comment.id} className="item-card">
                            <div className="item-header">
                              <span className="item-name">{comment.user}</span>
                              <span className="item-meta">
                                {new Date(comment.created_at).toLocaleString(
                                  "pt-BR"
                                )}
                              </span>
                            </div>
                            <p className="item-text">{comment.message}</p>
                          </article>
                        ))}
                      </section>
                    )}
                  </>
                )}
              </div>
            </div>
          )}

          {activeTab === "raw" && (
            <div className="panel">
              <div className="panel-toolbar">
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => handleCopy(rawJson, "JSON copiado")}
                >
                  Copiar JSON
                </button>
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => downloadJson(result)}
                >
                  Baixar .json
                </button>
                {copyFeedback && (
                  <span className="copy-feedback">{copyFeedback}</span>
                )}
              </div>
              <pre className="json-pre">{rawJson}</pre>
            </div>
          )}

          {activeTab === "analise" && (
            <div className="panel">
              <div className="panel-toolbar">
                <button
                  type="button"
                  className="btn"
                  onClick={() => runAnalyze(false)}
                  disabled={analyzing}
                >
                  {analyzing
                    ? "Analisando..."
                    : hasAnalyzed
                      ? "Analisar de novo (do zero)"
                      : "Analisar com IA"}
                </button>
                {hasAnalyzed && (
                  <button
                    type="button"
                    className="btn btn-secondary"
                    onClick={() => runAnalyze(true)}
                    disabled={analyzing || !hasRespostas}
                    title={
                      hasRespostas
                        ? "Reavalia os gaps considerando suas respostas"
                        : "Responda ao menos um gap para reprocessar"
                    }
                  >
                    Reprocessar
                  </button>
                )}
              </div>
              <div className="panel-content">
                {analysisError && (
                  <div className="error-box">{analysisError}</div>
                )}

                {diff && (
                  <div className="diff-banner">
                    <span className="diff-pill diff-resolved">
                      {diff.resolvidos.length} resolvidos
                    </span>
                    <span className="diff-pill diff-new">
                      {diff.novos.length} novos
                    </span>
                    <span className="diff-pill diff-open">
                      {diff.abertos.length} ainda abertos
                    </span>
                  </div>
                )}

                {!hasAnalyzed && !analyzing && (
                  <div className="empty-state">
                    Clique em "Analisar com IA" para rodar a crítica do
                    Discovery e listar os gaps por severidade.
                  </div>
                )}

                {hasAnalyzed && gaps.length === 0 && (
                  <div className="empty-state">
                    Nenhum gap encontrado. O Discovery parece completo o
                    suficiente para gerar o PRD.
                  </div>
                )}

                {Array.from(groupedGaps.entries()).map(([sev, list]) => (
                  <section key={sev}>
                    <h2 className="group-title">
                      Severidade {SEVERIDADE_LABELS[sev]} ({list.length})
                    </h2>
                    {list.map((gap) => (
                      <article key={gap.id} className="gap-card">
                        <div className="gap-header">
                          <span className={`sev-badge sev-${sev}`}>
                            {SEVERIDADE_LABELS[sev]}
                          </span>
                          <span className="gap-categoria">
                            {CATEGORIA_LABELS[gap.categoria] ?? gap.categoria}
                          </span>
                          <span className="item-meta">{gap.localizacao}</span>
                        </div>
                        <div className="gap-titulo">{gap.titulo}</div>
                        <p className="item-text">{gap.descricao}</p>
                        {gap.sugestao && (
                          <p className="gap-sugestao">
                            <strong>Sugestão:</strong> {gap.sugestao}
                          </p>
                        )}
                        <textarea
                          className="gap-resposta"
                          placeholder="Responda aqui para resolver este gap no reprocessamento..."
                          value={respostas[gap.id] ?? ""}
                          onChange={(e) =>
                            setRespostas((prev) => ({
                              ...prev,
                              [gap.id]: e.target.value,
                            }))
                          }
                        />
                      </article>
                    ))}
                  </section>
                ))}
              </div>
            </div>
          )}

          {activeTab === "prd" && (
            <div className="panel">
              <div className="panel-toolbar">
                <button
                  type="button"
                  className="btn"
                  onClick={handleGeneratePrd}
                  disabled={
                    prdLoading || !hasAnalyzed || blockingGaps.length > 0
                  }
                  title={
                    !hasAnalyzed
                      ? "Rode a análise primeiro"
                      : blockingGaps.length > 0
                        ? `Resolva os ${blockingGaps.length} gap(s) de severidade alta`
                        : "Gera o PRD a partir do Discovery e das respostas"
                  }
                >
                  {prdLoading ? "Gerando..." : "Gerar PRD"}
                </button>
                {prd && (
                  <>
                    <button
                      type="button"
                      className="btn btn-secondary"
                      onClick={() => handleCopy(prd, "PRD copiado")}
                    >
                      Copiar PRD
                    </button>
                    <button
                      type="button"
                      className="btn btn-secondary"
                      onClick={() =>
                        downloadText(
                          prd,
                          `PRD_${result.metadata.name.replace(/[^a-z0-9-_]+/gi, "_")}.md`
                        )
                      }
                    >
                      Baixar .md
                    </button>
                  </>
                )}
                {copyFeedback && (
                  <span className="copy-feedback">{copyFeedback}</span>
                )}
              </div>
              <div className="panel-content">
                {prdError && <div className="error-box">{prdError}</div>}

                {!hasAnalyzed && (
                  <div className="empty-state">
                    Rode a análise na aba "Análise (IA)" antes de gerar o PRD.
                  </div>
                )}

                {hasAnalyzed && blockingGaps.length > 0 && (
                  <div className="warn-box">
                    {blockingGaps.length} gap(s) de severidade alta ainda em
                    aberto. Responda-os e reprocesse para liberar a geração do
                    PRD.
                  </div>
                )}

                {hasAnalyzed && blockingGaps.length === 0 && !prd && (
                  <div className="empty-state">
                    Tudo liberado. Clique em "Gerar PRD".
                  </div>
                )}

                {prd && <pre className="prd-pre">{prd}</pre>}
              </div>
            </div>
          )}
        </>
      )}

      {!result && !error && !loading && (
        <div className="empty-state">
          Informe a URL do FigJam e clique em Extrair para começar.
        </div>
      )}
    </div>
  );
}
