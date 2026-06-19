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
import type { ProjectDetail, ProjectSummary } from "../types";

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

  // Registra um job "running" no estado local para o polling acompanhar o
  // progresso. O processamento em si roda no backend (Edge Function + cron),
  // então NÃO depende da aba do navegador ficar aberta.
  const trackJob = useCallback(
    (projectId: string, projectName: string, progress?: { processed: number; total: number }) => {
      setJob({
        projectId,
        projectName,
        status: "running",
        processed: progress?.processed ?? 0,
        total: progress?.total ?? 1,
      });
    },
    [setJob]
  );

  const resumeAnalysis = useCallback(
    (projectId: string, projectName: string, progress?: { processed: number; total: number }) => {
      setJobs((prev) => {
        if (prev[projectId]?.status === "running") return prev;
        return {
          ...prev,
          [projectId]: {
            projectId,
            projectName,
            status: "running",
            processed: progress?.processed ?? 0,
            total: progress?.total ?? 1,
          },
        };
      });
    },
    []
  );

  const startAnalysis = useCallback(
    async (
      projectId: string,
      projectName: string,
      reprocess: boolean,
      responses?: Record<string, string>
    ) => {
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

      trackJob(projectId, projectName, {
        processed: start.processed ?? 0,
        total: start.total,
      });
    },
    [trackJob]
  );

  // Acompanha jobs em andamento ao entrar (ex.: usuário recarregou ou outra aba
  // iniciou). O backend continua processando; aqui só exibimos o progresso.
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
