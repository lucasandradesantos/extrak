import {
  Alert,
  Button,
  Card,
  Collapse,
  Empty,
  Flex,
  Modal,
  Progress,
  Select,
  Space,
  Spin,
  Tabs,
  Tag,
  Typography,
  message,
} from "antd";
import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useAnalysis } from "../analysis/AnalysisContext";
import { GapCard } from "../components/GapCard";
import { SourceViewPanel } from "../components/SourceViewPanel";
import { apiFetch } from "../lib/api";
import {
  SEVERIDADE_LABELS,
  SEVERIDADE_ORDER,
  SOURCE_LABELS,
} from "../lib/labels";
import type {
  AnalysisCompareResult,
  AnalysisHistoryItem,
  Gap,
  GapSeveridade,
  GapSource,
  GapStatus,
  ProjectDetail,
  ProjectSource,
} from "../types";

const { Title, Text, Paragraph } = Typography;

type Tab = "discovery" | "prototype" | "analise" | "prd" | "historico";

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function figmaVersion(item: {
  source_metadata: { discovery?: { lastModified?: string } | null } | null;
}): string | null {
  return item.source_metadata?.discovery?.lastModified ?? null;
}

async function copy(text: string): Promise<void> {
  await navigator.clipboard.writeText(text);
}

function downloadText(text: string, filename: string): void {
  const blob = new Blob([text], { type: "text/markdown" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function sevTagColor(sev: GapSeveridade): "error" | "warning" | "default" {
  if (sev === "alta") return "error";
  if (sev === "media") return "warning";
  return "default";
}

function groupBySeveridade(gaps: Gap[]): Map<GapSeveridade, Gap[]> {
  const grouped = new Map<GapSeveridade, Gap[]>();
  for (const sev of SEVERIDADE_ORDER) {
    const list = gaps.filter((g) => g.severidade === sev);
    if (list.length > 0) grouped.set(sev, list);
  }
  return grouped;
}

function sourceSummaryChips(source: ProjectSource | undefined) {
  const summary = source?.metadata?.summary;
  if (!summary) return null;
  return (
    <Space wrap>
      {Object.entries(summary).map(([key, value]) => (
        <Tag key={key}>
          {value} {key}
        </Tag>
      ))}
    </Space>
  );
}

function roundGapSummary(gaps: Gap[]) {
  let resolved = 0;
  let withComment = 0;
  let reminders = 0;
  for (const gap of gaps) {
    if (gap.status === "resolvido") resolved += 1;
    if (gap.resposta?.trim()) withComment += 1;
    if (gap.figma_reminder_sent_at) reminders += 1;
  }
  return { resolved, withComment, reminders, total: gaps.length };
}

export function ProjectPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { getJob, startAnalysis, resumeAnalysis, isRunning, completion } = useAnalysis();

  const [detail, setDetail] = useState<ProjectDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("discovery");

  const [respostas, setRespostas] = useState<Record<string, string>>({});
  const [statuses, setStatuses] = useState<Record<string, GapStatus>>({});
  const [analiseSource, setAnaliseSource] = useState<"todos" | GapSource>("todos");
  const [analysisError, setAnalysisError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);

  const [prd, setPrd] = useState<string | null>(null);
  const [prdLoading, setPrdLoading] = useState(false);
  const [prdError, setPrdError] = useState<string | null>(null);

  const [history, setHistory] = useState<AnalysisHistoryItem[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [compareFrom, setCompareFrom] = useState<string>("");
  const [compareTo, setCompareTo] = useState<string>("");
  const [compareResult, setCompareResult] = useState<AnalysisCompareResult | null>(null);
  const [comparing, setComparing] = useState(false);
  const [sourceFilter, setSourceFilter] = useState<"todos" | GapSource>("todos");
  const [expandedRound, setExpandedRound] = useState<string | null>(null);
  const [roundGaps, setRoundGaps] = useState<Record<string, Gap[]>>({});
  const [roundLoading, setRoundLoading] = useState<string | null>(null);
  const [reminderByGapId, setReminderByGapId] = useState<
    Record<string, { sentAt: string; nodeName?: string | null }>
  >({});

  const job = id ? getJob(id) : undefined;
  const analyzing = id ? isRunning(id) : false;
  const analysisBusy = analyzing || starting;
  const progress =
    job && (job.status === "running" || starting)
      ? { processed: job.processed, total: job.total }
      : null;
  const analysisSpinTip =
    starting && !progress
      ? "Atualizando Discovery no Figma…"
      : progress
        ? `Análise em andamento — ${progress.processed}/${progress.total} blocos`
        : "Analisando…";

  const prevJobStatus = useRef<string | undefined>(undefined);

  async function load() {
    setLoading(true);
    try {
      const data = await apiFetch<ProjectDetail>(`/api/projects/${id}`, {
        fallback: "Erro ao carregar o projeto.",
      });
      setDetail(data);
      const resp: Record<string, string> = {};
      const stat: Record<string, GapStatus> = {};
      for (const gap of data.gaps) {
        if (gap.resposta) resp[gap.id] = gap.resposta;
        stat[gap.id] = gap.status;
      }
      setRespostas(resp);
      setStatuses(stat);
      setReminderByGapId((prev) => {
        const next = { ...prev };
        for (const gap of data.gaps) {
          if (gap.figma_reminder_sent_at) {
            next[gap.id] = {
              sentAt: gap.figma_reminder_sent_at,
              nodeName: gap.figma_reminder_node_name,
            };
          }
        }
        return next;
      });
      setPrd(data.prd?.content_md ?? null);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Erro ao carregar.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  useEffect(() => {
    if (!id || !detail || loading) return;
    if (detail.job?.status === "running" && !isRunning(id)) {
      resumeAnalysis(id, detail.project.name, {
        processed: detail.job.processed_chunks,
        total: detail.job.total_chunks,
      });
    }
  }, [id, detail, loading, isRunning, resumeAnalysis]);

  useEffect(() => {
    if (!id || !job) return;
    if (prevJobStatus.current === "running" && job.status === "done") {
      load();
      setTab("analise");
    }
    prevJobStatus.current = job.status;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job?.status, id]);

  useEffect(() => {
    if (completion?.projectId === id) {
      load();
      setTab("analise");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [completion, id]);

  useEffect(() => {
    if (tab === "historico") loadHistory();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, id, completion]);

  const gaps = detail?.gaps ?? [];

  function withReminderState(gap: Gap): Gap {
    const reminder = reminderByGapId[gap.id];
    if (reminder) {
      return {
        ...gap,
        figma_reminder_sent_at: reminder.sentAt,
        figma_reminder_node_name: reminder.nodeName ?? gap.figma_reminder_node_name,
      };
    }
    return gap;
  }

  const sourceCounts = useMemo(() => {
    const c = { discovery: 0, prototype: 0, comparacao: 0 } as Record<GapSource, number>;
    for (const g of gaps) c[g.source] += 1;
    return c;
  }, [gaps]);
  const filteredGaps = useMemo(
    () => (analiseSource === "todos" ? gaps : gaps.filter((g) => g.source === analiseSource)),
    [gaps, analiseSource]
  );
  const groupedGaps = useMemo(() => groupBySeveridade(filteredGaps), [filteredGaps]);
  const blockingGaps = useMemo(
    () =>
      gaps.filter((g) => {
        const status = statuses[g.id] ?? g.status;
        return g.severidade === "alta" && status !== "resolvido";
      }),
    [gaps, statuses]
  );
  const hasFeedback = useMemo(
    () =>
      gaps.some((g) => {
        const status = statuses[g.id] ?? g.status;
        const comment = respostas[g.id] ?? g.resposta;
        return status === "resolvido" || Boolean(comment?.trim());
      }),
    [gaps, statuses, respostas]
  );

  const discoverySource = detail?.sources.find((s) => s.kind === "discovery");
  const prototypeSource = detail?.sources.find((s) => s.kind === "prototype");
  const hasAnalyzed = gaps.length > 0 || detail?.analysis?.status === "done";
  const figmaReminderAvailable = Boolean(
    detail?.project.discovery_file_key || detail?.project.prototype_file_key
  );

  async function patchGaps(body: {
    responses?: Record<string, string>;
    statuses?: Record<string, GapStatus>;
  }) {
    await apiFetch<{ gaps: Gap[] }>(`/api/projects/${id}/gaps`, {
      method: "PATCH",
      body,
      fallback: "Erro ao salvar alterações nos gaps.",
    });
    await load();
  }

  async function markGapResolved(gapId: string, comment: string, reanalyzeAfter = false) {
    setRespostas((prev) => ({ ...prev, [gapId]: comment }));
    setStatuses((prev) => ({ ...prev, [gapId]: "resolvido" }));
    await patchGaps({
      responses: { [gapId]: comment },
      statuses: { [gapId]: "resolvido" },
    });
    message.success(
      reanalyzeAfter
        ? "Gap resolvido — iniciando análise com feedback..."
        : "Gap marcado como resolvido"
    );
    if (reanalyzeAfter) {
      await runAnalyze(true);
    }
  }

  async function reopenGap(gapId: string) {
    setStatuses((prev) => ({ ...prev, [gapId]: "aberto" }));
    await patchGaps({ statuses: { [gapId]: "aberto" } });
    message.success("Gap reaberto");
  }

  async function sendFigmaReminder(gap: Gap) {
    try {
      const result = await apiFetch<{
        nodeName: string;
        sentAt: string;
        gapId: string;
        figmaUrl?: string;
      }>(
        `/api/projects/${id}/gaps/${gap.id}/figma-reminder`,
        {
          method: "POST",
          fallback: "Erro ao enviar lembrete no Figma.",
        }
      );

      setReminderByGapId((prev) => ({
        ...prev,
        [gap.id]: { sentAt: result.sentAt, nodeName: result.nodeName },
      }));

      setDetail((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          gaps: prev.gaps.map((g) =>
            g.id === gap.id
              ? {
                  ...g,
                  figma_reminder_sent_at: result.sentAt,
                  figma_reminder_node_name: result.nodeName,
                }
              : g
          ),
        };
      });

      message.success(
        result.figmaUrl ? (
          <span>
            Lembrete publicado em &quot;{result.nodeName}&quot;.{" "}
            <a href={result.figmaUrl} target="_blank" rel="noreferrer">
              Abrir no Figma
            </a>
          </span>
        ) : (
          `Lembrete publicado no Figma (${result.nodeName})`
        )
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Erro ao enviar lembrete.";
      if (msg.includes("já foi enviado")) {
        setReminderByGapId((prev) => ({
          ...prev,
          [gap.id]: {
            sentAt: gap.figma_reminder_sent_at ?? new Date().toISOString(),
            nodeName: gap.figma_reminder_node_name,
          },
        }));
      }
      message.error(msg);
      throw err;
    }
  }

  function confirmNewRound(onOk: () => void) {
    Modal.confirm({
      title: "Analisar do zero?",
      width: 520,
      content: (
        <div>
          <Paragraph style={{ marginBottom: 12 }}>
            A Extrak vai baixar a versão <strong>atual</strong> do Discovery e Protótipo
            no Figma e gerar uma <strong>nova análise</strong> no histórico, sem considerar
            comentários nem resoluções anteriores.
          </Paragraph>
          <Alert
            type="warning"
            showIcon
            message="Confirme com o time de produto"
            description='Use esta opção quando quiser uma leitura limpa do board. Se você já marcou gaps como resolvidos ou deixou comentários, prefira "Analisar com feedback".'
          />
        </div>
      ),
      okText: "Sim, analisar do zero",
      cancelText: "Cancelar",
      onOk,
    });
  }

  function handleAnalyzeClick(reprocess: boolean) {
    if (!reprocess && hasAnalyzed) {
      confirmNewRound(() => runAnalyze(false));
      return;
    }
    runAnalyze(reprocess);
  }

  async function runAnalyze(reprocess: boolean) {
    if (!id || !detail) return;
    setStarting(true);
    setAnalysisError(null);
    try {
      await startAnalysis(
        id,
        detail.project.name,
        reprocess,
        reprocess ? respostas : undefined
      );
    } catch (err) {
      setAnalysisError(err instanceof Error ? err.message : "Erro na análise.");
    } finally {
      setStarting(false);
    }
  }

  async function handleGeneratePrd() {
    setPrdLoading(true);
    setPrdError(null);
    try {
      const data = await apiFetch<{ prd: string }>(`/api/projects/${id}/prd`, {
        method: "POST",
        fallback: "Erro ao gerar o PRD.",
      });
      setPrd(data.prd);
    } catch (err) {
      setPrdError(err instanceof Error ? err.message : "Erro ao gerar o PRD.");
    } finally {
      setPrdLoading(false);
    }
  }

  async function handleCopy(text: string, label: string) {
    await copy(text);
    message.success(label);
  }

  async function loadHistory() {
    if (!id) return;
    setHistoryLoading(true);
    setHistoryError(null);
    try {
      const data = await apiFetch<{ analyses: AnalysisHistoryItem[] }>(
        `/api/projects/${id}/analyses`,
        { fallback: "Erro ao carregar o histórico." }
      );
      const rounds = data.analyses;
      setHistory(rounds);
      if (rounds.length >= 2) {
        setCompareTo((prev) => prev || rounds[0].id);
        setCompareFrom((prev) => prev || rounds[1].id);
      }
    } catch (err) {
      setHistoryError(err instanceof Error ? err.message : "Erro ao carregar.");
    } finally {
      setHistoryLoading(false);
    }
  }

  async function toggleRound(analysisId: string) {
    if (expandedRound === analysisId) {
      setExpandedRound(null);
      return;
    }
    setExpandedRound(analysisId);
    if (roundGaps[analysisId]) return;
    setRoundLoading(analysisId);
    setHistoryError(null);
    try {
      const data = await apiFetch<{ gaps: Gap[] }>(
        `/api/projects/${id}/analyses/${analysisId}`,
        { fallback: "Erro ao carregar os gaps da rodada." }
      );
      setRoundGaps((prev) => ({ ...prev, [analysisId]: data.gaps }));
    } catch (err) {
      setHistoryError(err instanceof Error ? err.message : "Erro ao carregar.");
      setExpandedRound((prev) => (prev === analysisId ? null : prev));
    } finally {
      setRoundLoading(null);
    }
  }

  async function runCompare() {
    if (!id || !compareFrom || !compareTo) return;
    setComparing(true);
    setHistoryError(null);
    try {
      const data = await apiFetch<AnalysisCompareResult>(
        `/api/projects/${id}/analyses/compare?from=${compareFrom}&to=${compareTo}`,
        { fallback: "Erro ao comparar as rodadas." }
      );
      setCompareResult(data);
    } catch (err) {
      setHistoryError(err instanceof Error ? err.message : "Erro ao comparar.");
    } finally {
      setComparing(false);
    }
  }

  if (loading) {
    return (
      <div style={{ display: "grid", placeItems: "center", minHeight: 240 }}>
        <Spin tip="Carregando projeto..." />
      </div>
    );
  }

  if (loadError) {
    return <Alert type="error" message={loadError} showIcon />;
  }

  if (!detail) return null;

  const tabItems = [
    { key: "discovery", label: "Discovery" },
    ...(prototypeSource ? [{ key: "prototype", label: "Protótipo" }] : []),
    {
      key: "analise",
      label: `Análise (IA)${gaps.length > 0 ? ` · ${gaps.length}` : ""}`,
    },
    { key: "prd", label: "PRD" },
    { key: "historico", label: "Histórico" },
  ];

  return (
    <Space direction="vertical" size="large" style={{ width: "100%" }}>
      <div>
        <Button type="link" onClick={() => navigate("/")} style={{ paddingLeft: 0 }}>
          ← Projetos
        </Button>
        <Title level={2} style={{ margin: "4px 0 0" }}>
          {detail.project.name}
        </Title>
      </div>

      {starting && !progress && (
        <Alert
          type="info"
          showIcon
          message="Atualizando Discovery no Figma… re-baixando o board antes de analisar."
        />
      )}

      {(analyzing || starting) && progress && (
        <div>
          <Progress
            percent={progress.total ? Math.round((progress.processed / progress.total) * 100) : 0}
            status="active"
            strokeColor="#000"
          />
          <Text type="secondary" style={{ fontSize: 12 }}>
            Análise em andamento — {progress.processed}/{progress.total} blocos
            {progress.processed === 0
              ? " (aguardando a IA — o 1º bloco pode levar 1–3 min)"
              : ""}
            . Você ainda pode trocar de aba; avisamos quando terminar.
          </Text>
        </div>
      )}

      {job?.status === "error" && job.error && (
        <Alert type="error" message={job.error} showIcon />
      )}

      <Tabs activeKey={tab} onChange={(k) => setTab(k as Tab)} items={tabItems} />

      {tab === "discovery" && (
        <Card>
          <SourceViewPanel
            projectId={detail.project.id}
            kind="discovery"
            source={discoverySource}
            figmaUrl={detail.project.discovery_url}
            emptyText="Sem conteúdo extraído."
            copyLabel="Discovery copiado"
            onCopy={handleCopy}
            summaryChips={sourceSummaryChips(discoverySource)}
          />
        </Card>
      )}

      {tab === "prototype" && prototypeSource && (
        <Card>
          <SourceViewPanel
            projectId={detail.project.id}
            kind="prototype"
            source={prototypeSource}
            figmaUrl={detail.project.prototype_url}
            emptyText="Sem telas extraídas."
            copyLabel="Protótipo copiado"
            onCopy={handleCopy}
            summaryChips={sourceSummaryChips(prototypeSource)}
          />
        </Card>
      )}

      {tab === "analise" && (
        <Card>
          <Spin spinning={analysisBusy} tip={analysisSpinTip} size="large">
            <Flex wrap="wrap" gap={8} align="center" style={{ marginBottom: 16 }}>
              <Button
                type="primary"
                onClick={() => handleAnalyzeClick(false)}
                disabled={analysisBusy}
              >
                {analysisBusy
                  ? "Analisando..."
                  : hasAnalyzed
                    ? "Analisar do zero"
                    : "Iniciar análise"}
              </Button>
              {hasAnalyzed && (
                <Button
                  onClick={() => handleAnalyzeClick(true)}
                  disabled={analysisBusy || !hasFeedback}
                  title={
                    hasFeedback
                      ? "Baixa o Figma atual e analisa considerando resoluções e comentários"
                      : "Marque gaps como resolvidos ou adicione comentários antes de usar esta opção"
                  }
                >
                  Analisar com feedback
                </Button>
              )}
              {hasAnalyzed && gaps.length > 0 && (
                <Space align="center">
                  <Text type="secondary">Origem</Text>
                  <Select
                    value={analiseSource}
                    onChange={(v) => setAnaliseSource(v)}
                    style={{ minWidth: 200 }}
                    disabled={analysisBusy}
                    options={[
                      { value: "todos", label: `Todas (${gaps.length})` },
                      {
                        value: "discovery",
                        label: `${SOURCE_LABELS.discovery} (${sourceCounts.discovery})`,
                      },
                      {
                        value: "prototype",
                        label: `${SOURCE_LABELS.prototype} (${sourceCounts.prototype})`,
                      },
                      {
                        value: "comparacao",
                        label: `${SOURCE_LABELS.comparacao} (${sourceCounts.comparacao})`,
                      },
                    ]}
                  />
                </Space>
              )}
            </Flex>

            {analysisError && (
              <Alert type="error" message={analysisError} showIcon style={{ marginBottom: 16 }} />
            )}

            {!hasAnalyzed && !analysisBusy && (
              <Empty description="Clique em Iniciar análise para a IA revisar o Discovery e listar o que ainda falta definir." />
            )}

            {hasAnalyzed && gaps.length === 0 && (
              <Empty description="Por aqui está tudo certo — o Discovery parece pronto o suficiente para gerar o PRD." />
            )}

            {hasAnalyzed && gaps.length > 0 && filteredGaps.length === 0 && (
              <Empty
                description={`Nenhum gap da origem "${SOURCE_LABELS[analiseSource as GapSource]}".`}
              />
            )}

            {Array.from(groupedGaps.entries()).map(([sev, list]) => (
              <div key={sev} style={{ marginBottom: 24 }}>
                <Title level={5}>
                  Severidade {SEVERIDADE_LABELS[sev]} ({list.length})
                </Title>
                {list.map((gap) => {
                  const enrichedGap = withReminderState(gap);
                  return (
                    <GapCard
                      key={gap.id}
                      gap={enrichedGap}
                      resposta={respostas[gap.id]}
                      status={statuses[gap.id] ?? gap.status}
                      showActions={!analysisBusy}
                      onMarkResolved={(comment, reanalyze) =>
                        markGapResolved(gap.id, comment, reanalyze)
                      }
                      onReopen={() => reopenGap(gap.id)}
                      onSendFigmaReminder={() => sendFigmaReminder(enrichedGap)}
                      figmaReminderAvailable={figmaReminderAvailable}
                    />
                  );
                })}
              </div>
            ))}
          </Spin>
        </Card>
      )}

      {tab === "prd" && (
        <Card>
          <Flex wrap="wrap" gap={8} style={{ marginBottom: 16 }}>
            <Button
              type="primary"
              onClick={handleGeneratePrd}
              disabled={prdLoading || !hasAnalyzed || blockingGaps.length > 0}
              loading={prdLoading}
            >
              {prd ? "Gerar novamente" : "Gerar PRD"}
            </Button>
            {prd && (
              <>
                <Button onClick={() => handleCopy(prd, "PRD copiado")}>Copiar PRD</Button>
                <Button
                  onClick={() =>
                    downloadText(
                      prd,
                      `PRD_${detail.project.name.replace(/[^a-z0-9-_]+/gi, "_")}.md`
                    )
                  }
                >
                  Baixar .md
                </Button>
              </>
            )}
          </Flex>

          {prdError && <Alert type="error" message={prdError} showIcon style={{ marginBottom: 16 }} />}

          {!hasAnalyzed && (
            <Empty description="Rode a análise antes de gerar o PRD." />
          )}

          {hasAnalyzed && blockingGaps.length > 0 && (
            <Alert
              type="warning"
              showIcon
              style={{ marginBottom: 16 }}
              message={`${blockingGaps.length} gap(s) de severidade alta ainda em aberto. Responda-os e reprocesse para liberar a geração do PRD.`}
            />
          )}

          {hasAnalyzed && blockingGaps.length === 0 && !prd && (
            <Empty description='Tudo liberado. Clique em "Gerar PRD".' />
          )}

          {prd && <pre className="prd-pre">{prd}</pre>}
        </Card>
      )}

      {tab === "historico" && (
        <Card>
          {historyError && <Alert type="error" message={historyError} showIcon style={{ marginBottom: 16 }} />}

          {historyLoading && history.length === 0 && (
            <div style={{ textAlign: "center", padding: 32 }}>
              <Spin tip="Carregando histórico..." />
            </div>
          )}

          {!historyLoading && history.length === 0 && (
            <Empty description='Nenhuma rodada ainda. Rode a análise na aba "Análise (IA)".' />
          )}

          {history.length > 0 && (
            <Space direction="vertical" size="large" style={{ width: "100%" }}>
              <div>
                <Title level={5}>Rodadas</Title>
                <Collapse
                  accordion
                  activeKey={expandedRound ?? undefined}
                  onChange={(key) => {
                    const id = Array.isArray(key) ? key[0] : key;
                    if (id) toggleRound(id);
                    else setExpandedRound(null);
                  }}
                  items={history.map((item) => ({
                    key: item.id,
                    label: (
                      <Flex wrap="wrap" gap={8} align="center">
                        <Text strong>Rodada #{item.round}</Text>
                        <Text type="secondary" style={{ fontSize: 12 }}>
                          {formatDateTime(item.created_at)}
                        </Text>
                        <Tag>{item.status}</Tag>
                      </Flex>
                    ),
                    children: (
                      <div>
                        {(() => {
                          const gapsInRound = roundGaps[item.id] ?? [];
                          const summary = roundGapSummary(gapsInRound);
                          return (
                        <Space wrap style={{ marginBottom: 12 }}>
                          <Tag>{summary.total} gaps</Tag>
                          <Tag>{item.total} abertos</Tag>
                          <Tag color="success">{summary.resolved} resolvido(s)</Tag>
                          <Tag color="blue">{summary.withComment} com comentário</Tag>
                          {summary.reminders > 0 && (
                            <Tag color="processing">{summary.reminders} lembrete(s) Figma</Tag>
                          )}
                          <Tag color="error">{item.counts.alta} alta</Tag>
                          <Tag color="warning">{item.counts.media} média</Tag>
                          <Tag>{item.counts.baixa} baixa</Tag>
                          {figmaVersion(item) && (
                            <Tag title="Versão do board no Figma nesta rodada">
                              Figma: {formatDateTime(figmaVersion(item)!)}
                            </Tag>
                          )}
                        </Space>
                          );
                        })()}
                        {roundLoading === item.id && <Spin size="small" />}
                        {roundLoading !== item.id &&
                          (roundGaps[item.id]?.length ?? 0) === 0 && (
                            <Text type="secondary">Nenhum gap nesta rodada.</Text>
                          )}
                        {Array.from(
                          groupBySeveridade(roundGaps[item.id] ?? []).entries()
                        ).map(([sev, list]) => (
                          <div key={sev} style={{ marginTop: 16 }}>
                            <Title level={5}>
                              Severidade {SEVERIDADE_LABELS[sev]} ({list.length})
                            </Title>
                            {list.map((gap) => (
                              <GapCard
                                key={gap.id}
                                gap={
                                  detail?.analysis?.id === item.id
                                    ? withReminderState(gap)
                                    : gap
                                }
                                resposta={gap.resposta}
                                status={gap.status}
                                showActions={false}
                              />
                            ))}
                          </div>
                        ))}
                      </div>
                    ),
                  }))}
                />
              </div>

              {history.length >= 2 && (
                <div>
                  <Title level={5}>Comparar rodadas</Title>
                  <Flex wrap="wrap" gap={12} align="end" style={{ marginBottom: 16 }}>
                    <Space direction="vertical" size={4}>
                      <Text type="secondary">De</Text>
                      <Select
                        value={compareFrom}
                        onChange={setCompareFrom}
                        style={{ minWidth: 160 }}
                        options={history.map((item) => ({
                          value: item.id,
                          label: `Rodada #${item.round}`,
                        }))}
                      />
                    </Space>
                    <Space direction="vertical" size={4}>
                      <Text type="secondary">Para</Text>
                      <Select
                        value={compareTo}
                        onChange={setCompareTo}
                        style={{ minWidth: 160 }}
                        options={history.map((item) => ({
                          value: item.id,
                          label: `Rodada #${item.round}`,
                        }))}
                      />
                    </Space>
                    <Space direction="vertical" size={4}>
                      <Text type="secondary">Origem</Text>
                      <Select
                        value={sourceFilter}
                        onChange={(v) => setSourceFilter(v)}
                        style={{ minWidth: 180 }}
                        options={[
                          { value: "todos", label: "Todas" },
                          { value: "discovery", label: "Discovery" },
                          { value: "prototype", label: "Protótipo" },
                          { value: "comparacao", label: "Protótipo × Discovery" },
                        ]}
                      />
                    </Space>
                    <Button
                      type="primary"
                      onClick={runCompare}
                      disabled={comparing || !compareFrom || !compareTo || compareFrom === compareTo}
                      loading={comparing}
                    >
                      Comparar
                    </Button>
                  </Flex>
                  {compareResult && (
                    <CompareView result={compareResult} filter={sourceFilter} />
                  )}
                </div>
              )}
            </Space>
          )}
        </Card>
      )}
    </Space>
  );
}

function CompareView({
  result,
  filter,
}: {
  result: AnalysisCompareResult;
  filter: "todos" | GapSource;
}) {
  const byFilter = (gaps: Gap[]) =>
    filter === "todos" ? gaps : gaps.filter((g) => g.source === filter);

  const resolved = byFilter(result.resolved);
  const novos = byFilter(result.new);
  const persistent = byFilter(result.persistent);

  const fromVersion = result.from.source_metadata?.discovery?.lastModified;
  const toVersion = result.to.source_metadata?.discovery?.lastModified;
  const boardChanged = Boolean(fromVersion && toVersion && fromVersion !== toVersion);

  const block = (title: string, gaps: Gap[], borderColor: string) => (
    <Card
      size="small"
      title={
        <>
          {title} <Tag>{gaps.length}</Tag>
        </>
      }
      style={{ borderTop: `3px solid ${borderColor}` }}
    >
      {gaps.length === 0 ? (
        <Text type="secondary">Nenhum.</Text>
      ) : (
        <ul style={{ margin: 0, paddingLeft: 18 }}>
          {gaps.map((gap) => (
            <li key={gap.id} style={{ marginBottom: 8 }}>
              <Tag color={sevTagColor(gap.severidade)} style={{ marginRight: 8 }}>
                {SEVERIDADE_LABELS[gap.severidade]}
              </Tag>
              <Text>{gap.titulo}</Text>
              <Text type="secondary" style={{ fontSize: 12, marginLeft: 8 }}>
                {gap.localizacao}
              </Text>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );

  return (
    <div>
      <Paragraph type="secondary">
        Comparando rodada #{result.from.round} → #{result.to.round}
        {boardChanged && (
          <Tag color="processing" style={{ marginLeft: 8 }}>
            Board atualizado
          </Tag>
        )}
      </Paragraph>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
          gap: 16,
        }}
      >
        {block("Resolvidos", resolved, "#52c41a")}
        {block("Novos", novos, "#1677ff")}
        {block("Persistentes", persistent, "#faad14")}
      </div>
    </div>
  );
}
