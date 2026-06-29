import { DeleteOutlined, EditOutlined } from "@ant-design/icons";
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
import { ProjectFormModal, type ProjectFormValues } from "../components/ProjectFormModal";
import { ScopeTab } from "../components/ScopeTab";
import { SourceViewPanel } from "../components/SourceViewPanel";
import { apiFetch } from "../lib/api";
import { downloadDocsAsZip, downloadText, sanitizeFilename } from "../lib/download";
import { humanizeApiError } from "../lib/humanizeApiError";
import { validateQaTestCasesDoc } from "../lib/qaValidation";
import { formatActor } from "../lib/actors";
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
  SpecDoc,
} from "../types";

const { Title, Text, Paragraph } = Typography;

type Tab =
  | "discovery"
  | "prototype"
  | "analise"
  | "prd"
  | "escopo"
  | "specs"
  | "qa"
  | "historico";

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

function flattenSourceSummary(
  summary: NonNullable<NonNullable<ProjectSource["metadata"]>["summary"]>
): Array<{ key: string; value: number }> {
  const items: Array<{ key: string; value: number }> = [];
  for (const [key, value] of Object.entries(summary)) {
    if (typeof value === "number") {
      items.push({ key, value });
    } else if (value && typeof value === "object") {
      for (const [nestedKey, nestedValue] of Object.entries(value)) {
        if (typeof nestedValue === "number") {
          items.push({ key: nestedKey, value: nestedValue });
        }
      }
    }
  }
  return items;
}

function sourceSummaryChips(source: ProjectSource | undefined) {
  const summary = source?.metadata?.summary;
  if (!summary) return null;
  return (
    <Space wrap>
      {flattenSourceSummary(summary).map(({ key, value }) => (
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
  const [prdProgress, setPrdProgress] = useState<{
    current: number;
    total: number;
    label: string;
  } | null>(null);

  const [docs, setDocs] = useState<SpecDoc[]>([]);
  const [docsLoading, setDocsLoading] = useState(false);
  const [docsError, setDocsError] = useState<string | null>(null);
  const [docBusyKind, setDocBusyKind] = useState<string | null>(null);
  const [dsProgress, setDsProgress] = useState<{
    current: number;
    total: number;
    label: string;
  } | null>(null);
  const [packBusy, setPackBusy] = useState(false);

  const [qaDocs, setQaDocs] = useState<SpecDoc[]>([]);
  const [qaDocsLoading, setQaDocsLoading] = useState(false);
  const [qaDocsError, setQaDocsError] = useState<string | null>(null);
  const [qaProgress, setQaProgress] = useState<{
    current: number;
    total: number;
    label: string;
  } | null>(null);

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
  const [editOpen, setEditOpen] = useState(false);
  const [savingProject, setSavingProject] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  const [deletingProject, setDeletingProject] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);

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

  useEffect(() => {
    if (tab === "specs") loadDocs("spec");
    if (tab === "qa") loadDocs("qa");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, id]);

  useEffect(() => {
    if (!id || !detail || loading) return;
    if (detail.prd_job?.status === "running" && !prdLoading) {
      setPrdLoading(true);
      setPrdProgress({
        current: detail.prd_job.processed_steps,
        total: detail.prd_job.total_steps,
        label: detail.prd_job.current_step_label ?? "Gerando…",
      });
    }
  }, [id, detail, loading, prdLoading]);

  useEffect(() => {
    if (!id) return;
    const generating = prdLoading || detail?.prd_job?.status === "running";
    if (!generating) return;

    let cancelled = false;

    const poll = async () => {
      try {
        const status = await apiFetch<{
          status: "idle" | "running" | "done" | "error";
          total?: number;
          processed?: number;
          currentStepLabel?: string | null;
          error?: string | null;
          prd?: string | null;
        }>(`/api/projects/${id}/prd/status`, {
          fallback: "Erro ao acompanhar a geração do PRD.",
        });

        if (cancelled) return;

        if (status.status === "idle") return;

        if (status.status === "running") {
          setPrdProgress({
            current: status.processed ?? 0,
            total: status.total ?? 1,
            label: status.currentStepLabel ?? "Gerando…",
          });
          return;
        }

        setPrdLoading(false);
        setPrdProgress(null);

        if (status.status === "done") {
          setPrdError(null);
          if (status.prd) {
            setPrd(status.prd);
          } else {
            await load();
          }
          message.success("PRD gerado com sucesso.");
          return;
        }

        if (status.status === "error") {
          setPrdError(
            humanizeApiError(status.error ?? "Erro ao gerar o PRD.") +
              ' — clique em "Gerar novamente" para retomar de onde parou.'
          );
        }
      } catch {
        // Ignora falha pontual de polling.
      }
    };

    void poll();
    const interval = setInterval(poll, 3000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, prdLoading, detail?.prd_job?.status]);

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
  const prdGenerating =
    prdLoading || detail?.prd_job?.status === "running";
  const qaTestCasesDoc = qaDocs.find((d) => d.kind === "qa_test_cases");
  const qaIncompleteValidation = useMemo(() => {
    if (!qaTestCasesDoc?.content_md) return null;
    return (
      qaTestCasesDoc.qa_validation ??
      validateQaTestCasesDoc(qaTestCasesDoc.content_md)
    );
  }, [qaTestCasesDoc]);
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
    if (!id) return;
    setPrdLoading(true);
    setPrdError(null);
    setPrdProgress(null);

    try {
      const result = await apiFetch<{
        jobId: string;
        status: string;
        total: number;
        processed: number;
        currentStepLabel?: string | null;
        resumed?: boolean;
      }>(`/api/projects/${id}/prd/start`, {
        method: "POST",
        body: {},
        fallback: "Erro ao iniciar a geração do PRD.",
      });

      setPrdProgress({
        current: result.processed,
        total: result.total,
        label: result.currentStepLabel ?? "Iniciando…",
      });
    } catch (err) {
      setPrdError(err instanceof Error ? err.message : "Erro ao gerar o PRD.");
      setPrdLoading(false);
    }
  }

  function requestGeneratePrd() {
    handleGeneratePrd();
  }

  async function loadDocs(group: "spec" | "qa") {
    if (!id) return;
    const isQa = group === "qa";
    const setItems = isQa ? setQaDocs : setDocs;
    const setLoad = isQa ? setQaDocsLoading : setDocsLoading;
    const setErr = isQa ? setQaDocsError : setDocsError;
    setLoad(true);
    setErr(null);
    try {
      const data = await apiFetch<{ docs: SpecDoc[] }>(
        `/api/projects/${id}/docs?group=${group}`,
        { fallback: "Erro ao carregar os documentos." }
      );
      setItems(data.docs);
    } catch (err) {
      setErr(err instanceof Error ? err.message : "Erro ao carregar os documentos.");
    } finally {
      setLoad(false);
    }
  }

  async function generateDesignSystemDoc(): Promise<boolean> {
    if (!id) return false;
    setDocBusyKind("design_system");
    setDocsError(null);
    setDsProgress(null);

    try {
      const plan = await apiFetch<{
        steps: Array<{ id: string; label: string }>;
        total: number;
      }>(`/api/projects/${id}/docs/design_system/plan`, {
        fallback: "Erro ao planejar o Design System.",
      });

      const sections: Record<string, string> = {};

      for (const step of plan.steps) {
        setDsProgress({
          current: plan.steps.indexOf(step),
          total: plan.total,
          label: step.label,
        });

        let lastError: Error | null = null;
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            const result = await apiFetch<{
              stepId: string;
              content: string;
              index: number;
              total: number;
              done: boolean;
              doc?: SpecDoc;
            }>(`/api/projects/${id}/docs/design_system/step`, {
              method: "POST",
              body: { stepId: step.id, sections },
              fallback: `Erro ao gerar: ${step.label}`,
            });

            sections[result.stepId] = result.content;
            if (result.done && result.doc) {
              setDocs((prev) =>
                prev.map((d) => (d.kind === "design_system" ? result.doc! : d))
              );
            }
            lastError = null;
            break;
          } catch (err) {
            lastError = err instanceof Error ? err : new Error(String(err));
            if (attempt === 0) {
              await new Promise((r) => setTimeout(r, 1500));
            }
          }
        }

        if (lastError) {
          throw lastError;
        }
      }

      return true;
    } catch (err) {
      setDocsError(
        err instanceof Error ? err.message : "Erro ao gerar o Design System."
      );
      return false;
    } finally {
      setDocBusyKind(null);
      setDsProgress(null);
    }
  }

  async function generateQaTestCasesDoc(): Promise<boolean> {
    if (!id) return false;
    setDocBusyKind("qa_test_cases");
    setQaDocsError(null);
    setQaProgress(null);

    try {
      const plan = await apiFetch<{
        steps: Array<{ id: string; label: string }>;
        total: number;
      }>(`/api/projects/${id}/docs/qa_test_cases/plan`, {
        fallback: "Erro ao planejar os casos de teste.",
      });

      const sections: Record<string, string> = {};

      for (const step of plan.steps) {
        setQaProgress({
          current: plan.steps.indexOf(step),
          total: plan.total,
          label: step.label,
        });

        let lastError: Error | null = null;
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            const result = await apiFetch<{
              stepId: string;
              content: string;
              index: number;
              total: number;
              done: boolean;
              doc?: SpecDoc;
            }>(`/api/projects/${id}/docs/qa_test_cases/step`, {
              method: "POST",
              body: { stepId: step.id, sections },
              fallback: `Erro ao gerar: ${step.label}`,
            });

            sections[result.stepId] = result.content;
            if (result.done && result.doc) {
              setQaDocs((prev) =>
                prev.map((d) => (d.kind === "qa_test_cases" ? result.doc! : d))
              );
            }
            lastError = null;
            break;
          } catch (err) {
            lastError = err instanceof Error ? err : new Error(String(err));
            if (attempt === 0) {
              await new Promise((r) => setTimeout(r, 1500));
            }
          }
        }

        if (lastError) {
          throw new Error(
            `${lastError.message} — clique em "Gerar novamente" para retomar de "${step.label}".`
          );
        }
      }

      return true;
    } catch (err) {
      setQaDocsError(
        err instanceof Error ? err.message : "Erro ao gerar os casos de teste."
      );
      return false;
    } finally {
      setDocBusyKind(null);
      setQaProgress(null);
    }
  }

  async function generateDoc(kind: string, group: "spec" | "qa"): Promise<boolean> {
    if (!id) return false;
    if (kind === "design_system" && group === "spec") {
      return generateDesignSystemDoc();
    }
    if (kind === "qa_test_cases" && group === "qa") {
      return generateQaTestCasesDoc();
    }
    const isQa = group === "qa";
    const setItems = isQa ? setQaDocs : setDocs;
    const setErr = isQa ? setQaDocsError : setDocsError;
    setDocBusyKind(kind);
    setErr(null);
    try {
      const doc = await apiFetch<SpecDoc>(`/api/projects/${id}/docs/${kind}`, {
        method: "POST",
        fallback: "Erro ao gerar o documento.",
      });
      setItems((prev) => prev.map((d) => (d.kind === kind ? doc : d)));
      return true;
    } catch (err) {
      setErr(err instanceof Error ? err.message : "Erro ao gerar o documento.");
      return false;
    } finally {
      setDocBusyKind(null);
    }
  }

  async function generatePack() {
    if (!id || docs.length === 0) return;
    setPackBusy(true);
    setDocsError(null);
    try {
      for (const doc of docs) {
        const ok = await generateDoc(doc.kind, "spec");
        if (!ok) break;
      }
    } finally {
      setPackBusy(false);
    }
  }

  async function downloadAllDocs(items: SpecDoc[], options?: { requireQaComplete?: boolean }) {
    if (!detail) return;

    if (options?.requireQaComplete) {
      const qaDoc = items.find((d) => d.kind === "qa_test_cases" && d.content_md);
      if (qaDoc?.content_md) {
        const validation =
          qaDoc.qa_validation ?? validateQaTestCasesDoc(qaDoc.content_md);
        if (!validation.complete) {
          Modal.warning({
            title: "Documento de QA incompleto",
            content: (
              <div>
                <p>O pacote não pode ser enviado ao cliente neste estado.</p>
                <ul style={{ marginTop: 8, paddingLeft: 20 }}>
                  {validation.issues.map((issue) => (
                    <li key={issue}>{issue}</li>
                  ))}
                </ul>
                <p style={{ marginTop: 8 }}>
                  Clique em <strong>Gerar novamente</strong> para produzir o documento
                  completo.
                </p>
              </div>
            ),
          });
          return;
        }
      }
    }

    const files = items
      .filter((doc) => doc.content_md)
      .map((doc) => ({ filename: doc.filename, content: doc.content_md! }));
    await downloadDocsAsZip(files, detail.project.name);
  }

  function downloadQaMarkdown(doc: SpecDoc) {
    if (!doc.content_md) return;
    const validation = doc.qa_validation ?? validateQaTestCasesDoc(doc.content_md);
    if (!validation.complete) {
      Modal.warning({
        title: "Documento de QA incompleto",
        content: (
          <div>
            <p>Este arquivo parece truncado ou sem as seções obrigatórias.</p>
            <ul style={{ marginTop: 8, paddingLeft: 20 }}>
              {validation.issues.map((issue) => (
                <li key={issue}>{issue}</li>
              ))}
            </ul>
          </div>
        ),
      });
      return;
    }
    downloadText(doc.content_md, doc.filename);
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

  async function handleUpdateProject(values: ProjectFormValues) {
    if (!id) return;
    setSavingProject(true);
    setEditError(null);
    try {
      await apiFetch(`/api/projects/${id}`, {
        method: "PATCH",
        body: {
          name: values.name?.trim(),
          discoveryUrl: values.discoveryUrl.trim(),
          prototypeUrl: values.prototypeUrl?.trim() ?? "",
        },
        fallback: "Erro ao atualizar projeto.",
      });
      setEditOpen(false);
      message.success("Projeto atualizado");
      await load();
    } catch (err) {
      setEditError(err instanceof Error ? err.message : "Erro ao atualizar projeto.");
    } finally {
      setSavingProject(false);
    }
  }

  async function handleDeleteProject() {
    if (!id) return;
    setDeletingProject(true);
    try {
      await apiFetch(`/api/projects/${id}`, {
        method: "DELETE",
        fallback: "Erro ao excluir projeto.",
      });
      setDeleteOpen(false);
      message.success("Projeto excluído");
      navigate("/");
    } catch (err) {
      message.error(err instanceof Error ? err.message : "Erro ao excluir projeto.");
    } finally {
      setDeletingProject(false);
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
    { key: "escopo", label: "Escopo" },
    { key: "specs", label: "Specs" },
    { key: "qa", label: "QA" },
    { key: "historico", label: "Histórico" },
  ];

  return (
    <>
    <Space direction="vertical" size="large" style={{ width: "100%" }}>
      <div>
        <Button type="link" onClick={() => navigate("/")} style={{ paddingLeft: 0 }}>
          ← Projetos
        </Button>
        <Flex justify="space-between" align="flex-start" wrap="wrap" gap={12}>
          <div>
            <Title level={2} style={{ margin: "4px 0 0" }}>
              {detail.project.name}
            </Title>
            {detail.project.created_by && (
              <Text type="secondary" style={{ fontSize: 13 }}>
                Projeto criado por {formatActor(detail.project.created_by)} ·{" "}
                {formatDateTime(detail.project.created_at)}
              </Text>
            )}
          </div>
          <Space>
            <Button
              icon={<EditOutlined />}
              onClick={() => {
                setEditError(null);
                setEditOpen(true);
              }}
            >
              Editar
            </Button>
            <Button
              danger
              icon={<DeleteOutlined />}
              onClick={() => setDeleteOpen(true)}
            >
              Excluir
            </Button>
          </Space>
        </Flex>
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
        <Alert type="error" message={humanizeApiError(job.error)} showIcon />
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
              <Alert
                type="error"
                message={humanizeApiError(analysisError)}
                showIcon
                style={{ marginBottom: 16 }}
              />
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
              onClick={requestGeneratePrd}
              disabled={prdGenerating || !hasAnalyzed}
              loading={prdGenerating}
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
                      `PRD_${sanitizeFilename(detail.project.name)}.md`
                    )
                  }
                >
                  Baixar .md
                </Button>
              </>
            )}
          </Flex>

          {prdError && (
            <Alert
              type="error"
              message={humanizeApiError(prdError)}
              showIcon
              style={{ marginBottom: 16 }}
            />
          )}

          {!hasAnalyzed && (
            <Empty description="Rode a análise antes de gerar o PRD." />
          )}

          {prdGenerating && prdProgress && (
            <Alert
              type="info"
              showIcon
              style={{ marginBottom: 16 }}
              message={`Gerando PRD — ${prdProgress.current + 1}/${prdProgress.total}: ${prdProgress.label}`}
              description={
                <>
                  <Progress
                    percent={Math.round(((prdProgress.current + 1) / prdProgress.total) * 100)}
                    status="active"
                    strokeColor="#000"
                    style={{ marginTop: 8 }}
                  />
                  <Text type="secondary" style={{ fontSize: 12, display: "block", marginTop: 8 }}>
                    A geração roda no servidor — você pode fechar esta aba. Projetos grandes podem
                    levar 15–30 min. Se falhar, clique em "Gerar novamente" para retomar.
                  </Text>
                </>
              }
            />
          )}

          {hasAnalyzed && blockingGaps.length > 0 && (
            <Alert
              type="warning"
              showIcon
              style={{ marginBottom: 16 }}
              message={`${blockingGaps.length} gap(s) de severidade alta ainda em aberto`}
              description='O PRD será gerado completo mesmo assim: lacunas viram [A DEFINIR] nas seções afetadas e todos os gaps são listados na seção 10. Resolvê-los antes melhora a qualidade.'
            />
          )}

          {hasAnalyzed && !prd && !prdGenerating && (
            <Empty description='Clique em "Gerar PRD" para gerar o documento completo em passos.' />
          )}

          {prd && <pre className="prd-pre">{prd}</pre>}
        </Card>
      )}

      {tab === "escopo" && (
        <ScopeTab
          projectId={detail.project.id}
          projectName={detail.project.name}
          hasDiscovery={Boolean(discoverySource?.discovery_text?.trim())}
        />
      )}

      {tab === "specs" && (
        <Card>
          <Paragraph type="secondary" style={{ marginTop: 0 }}>
            Pacote de documentos para desenvolver o produto numa IDE com IA. Cada
            documento é gerado a partir do Discovery, do Protótipo e dos gaps.
          </Paragraph>

          <Flex wrap="wrap" gap={8} style={{ marginBottom: 16 }}>
            <Button
              type="primary"
              onClick={generatePack}
              disabled={!hasAnalyzed || packBusy || Boolean(docBusyKind)}
              loading={packBusy}
            >
              Gerar pacote completo
            </Button>
            {docs.some((d) => d.content_md) && (
              <Button onClick={() => downloadAllDocs(docs)} disabled={packBusy}>
                Baixar pacote (.zip)
              </Button>
            )}
          </Flex>

          {!hasAnalyzed && (
            <Empty description="Rode a análise antes de gerar os documentos." />
          )}

          {docsError && (
            <Alert
              type="error"
              message={humanizeApiError(docsError)}
              showIcon
              style={{ marginBottom: 16 }}
            />
          )}

          {dsProgress && (
            <Alert
              type="info"
              showIcon
              style={{ marginBottom: 16 }}
              message={`Gerando Design System — ${dsProgress.current + 1}/${dsProgress.total}: ${dsProgress.label}`}
              description="Mantenha esta aba aberta até concluir. O primeiro passo inclui tokens extraídos do Figma (cores hex, tipografia)."
            />
          )}

          {hasAnalyzed && (
            <Spin spinning={docsLoading}>
              <Collapse
                items={docs.map((doc) => ({
                  key: doc.kind,
                  label: (
                    <Flex justify="space-between" align="center" gap={8} wrap="wrap">
                      <span>
                        {doc.label}{" "}
                        {doc.version > 0 ? (
                          <Tag color="green">v{doc.version}</Tag>
                        ) : (
                          <Tag>não gerado</Tag>
                        )}
                      </span>
                      <Text type="secondary" style={{ fontSize: 12 }}>
                        {doc.filename}
                      </Text>
                    </Flex>
                  ),
                  children: (
                    <>
                      <Flex wrap="wrap" gap={8} style={{ marginBottom: 12 }}>
                        <Button
                          type="primary"
                          size="small"
                          onClick={() => generateDoc(doc.kind, "spec")}
                          loading={docBusyKind === doc.kind}
                          disabled={
                            packBusy ||
                            (Boolean(docBusyKind) && docBusyKind !== doc.kind)
                          }
                        >
                          {doc.content_md ? "Gerar novamente" : "Gerar"}
                        </Button>
                        {doc.content_md && (
                          <>
                            <Button
                              size="small"
                              onClick={() =>
                                handleCopy(doc.content_md!, `${doc.label} copiado`)
                              }
                            >
                              Copiar
                            </Button>
                            <Button
                              size="small"
                              onClick={() => downloadText(doc.content_md!, doc.filename)}
                            >
                              Baixar .md
                            </Button>
                          </>
                        )}
                      </Flex>
                      {doc.content_md ? (
                        <pre className="prd-pre">{doc.content_md}</pre>
                      ) : (
                        <Empty description="Documento ainda não gerado." />
                      )}
                    </>
                  ),
                }))}
              />
            </Spin>
          )}
        </Card>
      )}

      {tab === "qa" && (
        <Card>
          <Paragraph type="secondary" style={{ marginTop: 0 }}>
            Ambiente do QA. Gera Casos de Teste funcionais (manuais, caixa-preta)
            a partir do Discovery, do Protótipo e dos gaps, no padrão do time —
            pronto para enviar ao cliente.
          </Paragraph>

          <Flex wrap="wrap" gap={8} style={{ marginBottom: 16 }}>
            {qaDocs.some((d) => d.content_md) && (
              <Button
                onClick={() => downloadAllDocs(qaDocs, { requireQaComplete: true })}
              >
                Baixar pacote (.zip)
              </Button>
            )}
          </Flex>

          {qaIncompleteValidation && !qaIncompleteValidation.complete && (
            <Alert
              type="warning"
              showIcon
              style={{ marginBottom: 16 }}
              message="Documento de QA incompleto — não envie ao cliente"
              description={
                <ul style={{ margin: "8px 0 0", paddingLeft: 20 }}>
                  {qaIncompleteValidation.issues.map((issue) => (
                    <li key={issue}>{issue}</li>
                  ))}
                </ul>
              }
            />
          )}

          {qaProgress && (
            <Alert
              type="info"
              showIcon
              style={{ marginBottom: 16 }}
              message={`Gerando Casos de Teste — ${qaProgress.current + 1}/${qaProgress.total}: ${qaProgress.label}`}
              description="Mantenha esta aba aberta até concluir. Projetos grandes são gerados em vários passos para evitar truncamento."
            />
          )}

          {!hasAnalyzed && (
            <Empty description="Rode a análise antes de gerar os casos de teste." />
          )}

          {qaDocsError && (
            <Alert
              type="error"
              message={humanizeApiError(qaDocsError)}
              showIcon
              style={{ marginBottom: 16 }}
            />
          )}

          {hasAnalyzed && (
            <Spin spinning={qaDocsLoading}>
              <Collapse
                defaultActiveKey={qaDocs.map((d) => d.kind)}
                items={qaDocs.map((doc) => ({
                  key: doc.kind,
                  label: (
                    <Flex justify="space-between" align="center" gap={8} wrap="wrap">
                      <span>
                        {doc.label}{" "}
                        {doc.version > 0 ? (
                          <Tag color="green">v{doc.version}</Tag>
                        ) : (
                          <Tag>não gerado</Tag>
                        )}
                      </span>
                      <Text type="secondary" style={{ fontSize: 12 }}>
                        {doc.filename}
                      </Text>
                    </Flex>
                  ),
                  children: (
                    <>
                      <Flex wrap="wrap" gap={8} style={{ marginBottom: 12 }}>
                        <Button
                          type="primary"
                          size="small"
                          onClick={() => generateDoc(doc.kind, "qa")}
                          loading={docBusyKind === doc.kind}
                          disabled={
                            Boolean(docBusyKind) && docBusyKind !== doc.kind
                          }
                        >
                          {doc.content_md ? "Gerar novamente" : "Gerar"}
                        </Button>
                        {doc.content_md && (
                          <>
                            <Button
                              size="small"
                              onClick={() =>
                                handleCopy(doc.content_md!, `${doc.label} copiado`)
                              }
                            >
                              Copiar
                            </Button>
                            <Button
                              size="small"
                              onClick={() => downloadQaMarkdown(doc)}
                            >
                              Baixar .md
                            </Button>
                          </>
                        )}
                      </Flex>
                      {doc.content_md ? (
                        <pre className="prd-pre">{doc.content_md}</pre>
                      ) : (
                        <Empty description="Casos de teste ainda não gerados." />
                      )}
                    </>
                  ),
                }))}
              />
            </Spin>
          )}
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
                        {item.created_by && (
                          <Text type="secondary" style={{ fontSize: 12 }}>
                            por {formatActor(item.created_by)}
                          </Text>
                        )}
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

    <ProjectFormModal
      open={editOpen}
      mode="edit"
      project={detail.project}
      loading={savingProject}
      error={editError}
      onCancel={() => {
        setEditOpen(false);
        setEditError(null);
      }}
      onSubmit={handleUpdateProject}
    />

    <Modal
      title="Excluir projeto?"
      open={deleteOpen}
      onCancel={() => !deletingProject && setDeleteOpen(false)}
      footer={[
        <Button key="cancel" onClick={() => setDeleteOpen(false)} disabled={deletingProject}>
          Cancelar
        </Button>,
        <Button
          key="delete"
          type="primary"
          danger
          loading={deletingProject}
          onClick={handleDeleteProject}
        >
          Excluir projeto
        </Button>,
      ]}
    >
      <Paragraph>
        Tem certeza que deseja excluir <strong>{detail.project.name}</strong>?
      </Paragraph>
      <Paragraph type="secondary" style={{ marginBottom: 0 }}>
        Esta ação é permanente e remove análises, gaps, PRDs e todo o histórico
        associado a este projeto.
      </Paragraph>
    </Modal>
    </>
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
        {result.from.created_by && (
          <> · de: {formatActor(result.from.created_by)}</>
        )}
        {result.to.created_by && (
          <> · para: {formatActor(result.to.created_by)}</>
        )}
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
