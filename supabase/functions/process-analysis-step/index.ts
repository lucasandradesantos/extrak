// Supabase Edge Function: orquestra jobs pesados no backend (análise e PRD).
//
// Dois modos:
//   1. { projectId, jobType? }  -> processa o projeto passo a passo chamando a
//      rota interna na Vercel até o job terminar. Se o tempo da função acabar,
//      reinvoca a si mesma para continuar (chain).
//   2. {} (cron)                -> recupera jobs "running" travados e dispara
//      uma execução por projeto (análise e PRD).
//
// Secrets necessários (Supabase Dashboard > Edge Functions > Secrets):
//   - ANALYSIS_WORKER_SECRET  (mesmo valor configurado na Vercel)
//   - VERCEL_APP_URL          (ex.: https://extrak-three.vercel.app)
// SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY já estão disponíveis no runtime.

import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const WORKER_SECRET = Deno.env.get("ANALYSIS_WORKER_SECRET") ?? "";
const VERCEL_APP_URL = (Deno.env.get("VERCEL_APP_URL") ?? "").replace(/\/$/, "");

const MAX_RUNTIME_MS = 100_000;
const STALE_MS = 2 * 60 * 1000;

const SELF_URL = `${SUPABASE_URL}/functions/v1/process-analysis-step`;

type JobType = "analysis" | "prd" | "scope";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function internalPath(jobType: JobType): string {
  if (jobType === "prd") return "/api/internal/prd/step";
  if (jobType === "scope") return "/api/internal/scope/step";
  return "/api/internal/analysis/step";
}

async function callInternalStep(
  projectId: string,
  jobType: JobType
): Promise<{ status?: string; skipped?: boolean; error?: string }> {
  const response = await fetch(`${VERCEL_APP_URL}${internalPath(jobType)}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Worker-Secret": WORKER_SECRET,
    },
    body: JSON.stringify({ projectId }),
  });
  return (await response.json().catch(() => ({}))) as {
    status?: string;
    skipped?: boolean;
    error?: string;
  };
}

async function invokeSelf(body: Record<string, unknown>): Promise<void> {
  await fetch(SELF_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
      "X-Worker-Secret": WORKER_SECRET,
    },
    body: JSON.stringify(body),
  }).catch((error) => console.error("[edge] invokeSelf falhou:", error));
}

async function processProject(
  projectId: string,
  jobType: JobType,
  startedAt: number
): Promise<void> {
  while (Date.now() - startedAt < MAX_RUNTIME_MS) {
    let result: { status?: string; skipped?: boolean; error?: string };
    try {
      result = await callInternalStep(projectId, jobType);
    } catch (error) {
      console.error(`[edge] erro ao chamar rota interna (${jobType}, ${projectId}):`, error);
      await invokeSelf({ projectId, jobType });
      return;
    }

    if (result.skipped) {
      await sleep(2000);
      continue;
    }
    if (result.status !== "running") {
      return;
    }
  }

  await invokeSelf({ projectId, jobType });
}

async function recoverStaleJobs(startedAt: number): Promise<number> {
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const cutoff = new Date(Date.now() - STALE_MS).toISOString();

  const [
    { data: analysisJobs, error: analysisError },
    { data: prdJobs, error: prdError },
    { data: scopeJobs, error: scopeError },
  ] = await Promise.all([
    admin
      .from("analysis_jobs")
      .select("project_id, updated_at")
      .eq("status", "running")
      .lt("updated_at", cutoff),
    admin
      .from("prd_jobs")
      .select("project_id, updated_at")
      .eq("status", "running")
      .lt("updated_at", cutoff),
    admin
      .from("scope_jobs")
      .select("project_id, updated_at")
      .eq("status", "running")
      .lt("updated_at", cutoff),
  ]);

  if (analysisError) {
    console.error("[edge] erro ao buscar analysis jobs travados:", analysisError);
  }
  if (prdError) {
    console.error("[edge] erro ao buscar prd jobs travados:", prdError);
  }
  if (scopeError) {
    console.error("[edge] erro ao buscar scope jobs travados:", scopeError);
  }

  const invocations: Array<{ projectId: string; jobType: JobType }> = [
    ...(analysisJobs ?? []).map((j) => ({
      projectId: j.project_id as string,
      jobType: "analysis" as const,
    })),
    ...(prdJobs ?? []).map((j) => ({
      projectId: j.project_id as string,
      jobType: "prd" as const,
    })),
    ...(scopeJobs ?? []).map((j) => ({
      projectId: j.project_id as string,
      jobType: "scope" as const,
    })),
  ];

  for (const { projectId, jobType } of invocations) {
    if (Date.now() - startedAt < MAX_RUNTIME_MS) {
      await invokeSelf({ projectId, jobType });
    }
  }

  return invocations.length;
}

Deno.serve(async (req) => {
  const startedAt = Date.now();

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { "Content-Type": "application/json" },
    });
  }

  let body: { projectId?: string; jobType?: JobType } = {};
  try {
    body = await req.json();
  } catch {
    body = {};
  }

  if (!VERCEL_APP_URL || !WORKER_SECRET) {
    console.error("[edge] VERCEL_APP_URL ou ANALYSIS_WORKER_SECRET não configurados.");
    return new Response(
      JSON.stringify({ error: "Worker não configurado." }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }

  const jobType: JobType =
    body.jobType === "prd" || body.jobType === "scope" ? body.jobType : "analysis";

  if (body.projectId) {
    await processProject(body.projectId, jobType, startedAt);
    return new Response(
      JSON.stringify({ ok: true, projectId: body.projectId, jobType }),
      { headers: { "Content-Type": "application/json" } }
    );
  }

  const recovered = await recoverStaleJobs(startedAt);
  return new Response(JSON.stringify({ ok: true, recovered }), {
    headers: { "Content-Type": "application/json" },
  });
});
