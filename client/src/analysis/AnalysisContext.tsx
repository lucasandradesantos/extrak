import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useAuth } from "../auth/AuthContext";
import { apiFetch } from "../lib/api";
import { humanizeApiError } from "../lib/humanizeApiError";
import type { ProjectDetail, ProjectSummary, StepResponse } from "../types";

export interface AnalysisJobState {
  projectId: string;
  projectName: string;
  status: "running" | "done" | "error";
  processed: number;
  total: number;
  error?: string;
}

export interface AnalysisCompletion {
  projectId: string;
  projectName: string;
}

interface AnalysisContextValue {
  jobs: Record<string, AnalysisJobState>;
  completion: AnalysisCompletion | null;
  isRunning: (projectId: string) => boolean;
  getJob: (projectId: string) => AnalysisJobState | undefined;
  startAnalysis: (
    projectId: string,
    projectName: string,
    reprocess: boolean,
    responses?: Record<string, string>
  ) => Promise<void>;
  resumeAnalysis: (
    projectId: string,
    projectName: string,
    progress?: { processed: number; total: number }
  ) => void;
  dismissCompletion: () => void;
}

const AnalysisContext = createContext<AnalysisContextValue | undefined>(undefined);

/** Evita dois loops simultâneos no mesmo projeto. */
const activeRunners = new Map<string, Promise<void>>();

async function runStepsUntilDone(
  projectId: string,
  onProgress: (step: StepResponse) => void
): Promise<StepResponse> {
  let last: StepResponse = { status: "running", processed: 0, total: 1 };
  let done = false;

  while (!done) {
    let attempt = 0;
    const maxAttempts = 3;

    while (attempt < maxAttempts) {
      try {
        last = await apiFetch<StepResponse>(`/api/projects/${projectId}/analyze/step`, {
          method: "POST",
          fallback: "Erro ao processar a análise.",
        });
        break;
      } catch (err) {
        attempt++;
        const message = err instanceof Error ? err.message : "";
        const retryable =
          /fetch|network|socket|timeout|aborted|failed/i.test(message) ||
          message.includes("Erro ao processar");

        if (!retryable || attempt >= maxAttempts) throw err;
        await new Promise((r) => setTimeout(r, 2000 * attempt));
      }
    }

    onProgress(last);
    if (last.status === "done") done = true;
  }

  return last;
}

export function AnalysisProvider({ children }: { children: ReactNode }) {
  const { session } = useAuth();
  const [jobs, setJobs] = useState<Record<string, AnalysisJobState>>({});
  const [completion, setCompletion] = useState<AnalysisCompletion | null>(null);

  const patchJob = useCallback((projectId: string, patch: Partial<AnalysisJobState>) => {
    setJobs((prev) => {
      const current = prev[projectId];
      if (!current) return prev;
      return { ...prev, [projectId]: { ...current, ...patch } };
    });
  }, []);

  const setJob = useCallback((job: AnalysisJobState) => {
    setJobs((prev) => ({ ...prev, [job.projectId]: job }));
  }, []);

  const executeSteps = useCallback(
    (projectId: string, projectName: string, initial?: { processed: number; total: number }) => {
      if (activeRunners.has(projectId)) return activeRunners.get(projectId)!;

      setJob({
        projectId,
        projectName,
        status: "running",
        processed: initial?.processed ?? 0,
        total: initial?.total ?? 1,
      });

      const promise = (async () => {
        try {
          await runStepsUntilDone(projectId, (step) => {
            setJob({
              projectId,
              projectName,
              status: step.status === "done" ? "done" : "running",
              processed: step.processed,
              total: step.total,
            });
          });

          setCompletion({ projectId, projectName });
        } catch (err) {
          const message = err instanceof Error ? err.message : "Erro na análise.";
          patchJob(projectId, { status: "error", error: message });
        } finally {
          activeRunners.delete(projectId);
        }
      })();

      activeRunners.set(projectId, promise);
      return promise;
    },
    [patchJob, setJob]
  );

  const resumeAnalysis = useCallback(
    (projectId: string, projectName: string, progress?: { processed: number; total: number }) => {
      if (activeRunners.has(projectId)) return;
      executeSteps(projectId, projectName, progress);
    },
    [executeSteps]
  );

  const startAnalysis = useCallback(
    async (
      projectId: string,
      projectName: string,
      reprocess: boolean,
      responses?: Record<string, string>
    ) => {
      if (activeRunners.has(projectId)) return;

      if (reprocess && responses) {
        await apiFetch(`/api/projects/${projectId}/gaps`, {
          method: "PATCH",
          body: { responses },
          fallback: "Erro ao salvar respostas.",
        });
      }

      const start = await apiFetch<{ total: number; processed?: number }>(
        `/api/projects/${projectId}/analyze`,
        {
          method: "POST",
          body: { reprocess },
          fallback: "Erro ao iniciar análise.",
        }
      );

      await executeSteps(projectId, projectName, {
        processed: start.processed ?? 0,
        total: start.total,
      });
    },
    [executeSteps]
  );

  // Retoma jobs em andamento ao entrar (ex.: usuário saiu da tela ou recarregou).
  useEffect(() => {
    if (!session) return;

    let cancelled = false;

    (async () => {
      try {
        const { projects } = await apiFetch<{ projects: ProjectSummary[] }>("/api/projects", {
          fallback: "Erro ao listar projetos.",
        });
        if (cancelled) return;

        for (const project of projects) {
          if (project.analysis_status === "running") {
            resumeAnalysis(
              project.id,
              project.name,
              project.analysis_progress ?? undefined
            );
          }
        }
      } catch {
        // Ignora falha silenciosa no boot; o usuário pode retomar ao abrir o projeto.
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [session, resumeAnalysis]);

  // Sincroniza progresso lendo o job persistido no Supabase (útil se outra aba avançou).
  const jobsRef = useRef(jobs);
  jobsRef.current = jobs;

  useEffect(() => {
    if (!session) return;

    const interval = setInterval(async () => {
      const running = Object.values(jobsRef.current).filter((j) => j.status === "running");
      if (running.length === 0) return;

      for (const job of running) {
        try {
          const detail = await apiFetch<ProjectDetail>(`/api/projects/${job.projectId}`, {
            fallback: "Erro ao sincronizar análise.",
          });
          const dbJob = detail.job;
          if (!dbJob) continue;

          if (dbJob.status === "done") {
            setJob({
              projectId: job.projectId,
              projectName: job.projectName,
              status: "done",
              processed: dbJob.total_chunks,
              total: dbJob.total_chunks,
            });
            setCompletion({ projectId: job.projectId, projectName: job.projectName });
          } else if (dbJob.status === "error") {
            patchJob(job.projectId, {
              status: "error",
              error: humanizeApiError(dbJob.error ?? "Erro na análise."),
            });
          } else {
            patchJob(job.projectId, {
              processed: dbJob.processed_chunks,
              total: dbJob.total_chunks,
            });
          }
        } catch {
          // Ignora falha pontual de polling.
        }
      }
    }, 4000);

    return () => clearInterval(interval);
  }, [session, patchJob, setJob]);

  const value = useMemo<AnalysisContextValue>(
    () => ({
      jobs,
      completion,
      isRunning: (projectId) => jobs[projectId]?.status === "running",
      getJob: (projectId) => jobs[projectId],
      startAnalysis,
      resumeAnalysis,
      dismissCompletion: () => setCompletion(null),
    }),
    [jobs, completion, startAnalysis, resumeAnalysis]
  );

  return (
    <AnalysisContext.Provider value={value}>{children}</AnalysisContext.Provider>
  );
}

export function useAnalysis(): AnalysisContextValue {
  const ctx = useContext(AnalysisContext);
  if (!ctx) throw new Error("useAnalysis deve ser usado dentro de AnalysisProvider.");
  return ctx;
}
