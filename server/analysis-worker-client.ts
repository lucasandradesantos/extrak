import { runAnalysisStep } from "./analysis-runner";
import { runPrdStep } from "./prd-runner";
import { runScopeStep } from "./scope-runner";
import { getSupabaseAdmin } from "./supabase";

export type WorkerJobType = "analysis" | "prd" | "scope";

function workerSecret(): string | null {
  return process.env.ANALYSIS_WORKER_SECRET?.trim() || null;
}

function edgeFunctionUrl(): string | null {
  return process.env.SUPABASE_FUNCTION_URL?.trim() || null;
}

function internalBaseUrl(): string {
  if (process.env.VERCEL_URL) {
    return `https://${process.env.VERCEL_URL}`;
  }
  const port = process.env.PORT ?? "3001";
  return `http://127.0.0.1:${port}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function internalStepPath(jobType: WorkerJobType): string {
  if (jobType === "prd") return "/api/internal/prd/step";
  if (jobType === "scope") return "/api/internal/scope/step";
  return "/api/internal/analysis/step";
}

/**
 * Dispara o worker. Em produção invoca a Edge Function do Supabase (que reencadeia
 * passo a passo mesmo com a aba do usuário fechada). Sem Edge Function (dev local),
 * encadeia no servidor Node.
 */
export function scheduleWorker(projectId: string, jobType: WorkerJobType = "analysis"): void {
  const fnUrl = edgeFunctionUrl();
  const secret = workerSecret();
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();

  if (fnUrl && secret && serviceKey) {
    fetch(fnUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${serviceKey}`,
        "X-Worker-Secret": secret,
      },
      body: JSON.stringify({ projectId, jobType }),
    }).catch((error) => {
      console.error(
        `[worker] Falha ao invocar Edge Function (${jobType}); usando fallback no servidor:`,
        error
      );
      void chainJobOnServer(projectId, jobType);
    });
    return;
  }

  void chainJobOnServer(projectId, jobType);
}

export function scheduleAnalysisWorker(projectId: string): void {
  scheduleWorker(projectId, "analysis");
}

export function schedulePrdWorker(projectId: string): void {
  scheduleWorker(projectId, "prd");
}

export function scheduleScopeWorker(projectId: string): void {
  scheduleWorker(projectId, "scope");
}

async function callInternalStep(
  projectId: string,
  jobType: WorkerJobType,
  secret: string
): Promise<{ status?: string; skipped?: boolean }> {
  const response = await fetch(`${internalBaseUrl()}${internalStepPath(jobType)}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Worker-Secret": secret,
    },
    body: JSON.stringify({ projectId }),
  });
  return (await response.json()) as { status?: string; skipped?: boolean };
}

/**
 * Fallback: encadeia os passos no próprio processo Node.
 */
export async function chainJobOnServer(
  projectId: string,
  jobType: WorkerJobType = "analysis"
): Promise<void> {
  const secret = workerSecret();
  const maxSteps = 1000;

  for (let i = 0; i < maxSteps; i++) {
    if (secret) {
      try {
        const result = await callInternalStep(projectId, jobType, secret);
        if (result.skipped) {
          await sleep(1500);
          continue;
        }
        if (result.status !== "running") return;
        continue;
      } catch (error) {
        console.error(`[worker] Falha na rota interna (${jobType}); processando inline:`, error);
      }
    }

    const result =
      jobType === "prd"
        ? await runPrdStep(projectId, { force: !secret })
        : jobType === "scope"
          ? await runScopeStep(projectId, { force: !secret })
          : await runAnalysisStep(projectId, { force: !secret });

    if (result.skipped) {
      await sleep(1500);
      continue;
    }
    if (result.status !== "running") return;
  }
}

/** @deprecated Use chainJobOnServer */
export async function chainAnalysisOnServer(projectId: string): Promise<void> {
  return chainJobOnServer(projectId, "analysis");
}

/**
 * Recuperação local: ao subir o servidor, retoma jobs que ficaram "running" —
 * ex.: o processo reiniciou (hot-reload no dev, deploy, crash) e matou o loop
 * em memória. Só roda no fallback local (sem Edge Function); em produção a
 * Edge Function + pg_cron já fazem esse papel.
 */
export async function recoverLocalJobs(): Promise<void> {
  if (edgeFunctionUrl()) return;

  const tables: Array<{ table: string; jobType: WorkerJobType }> = [
    { table: "analysis_jobs", jobType: "analysis" },
    { table: "prd_jobs", jobType: "prd" },
    { table: "scope_jobs", jobType: "scope" },
  ];

  try {
    const admin = getSupabaseAdmin();
    for (const { table, jobType } of tables) {
      const { data } = await admin
        .from(table)
        .select("project_id")
        .eq("status", "running");

      const projectIds = Array.from(
        new Set((data ?? []).map((row) => row.project_id as string))
      );
      for (const projectId of projectIds) {
        console.log(`[worker] Retomando job ${jobType} do projeto ${projectId} após restart.`);
        scheduleWorker(projectId, jobType);
      }
    }
  } catch (error) {
    console.error("[worker] Falha ao recuperar jobs locais:", error);
  }
}
