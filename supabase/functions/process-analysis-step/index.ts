// Supabase Edge Function: orquestra a análise da IA no backend.
//
// Dois modos:
//   1. { projectId }  -> processa o projeto bloco a bloco chamando a rota
//      interna na Vercel até o job terminar. Se o tempo da função acabar,
//      reinvoca a si mesma para continuar (chain).
//   2. {} (cron)      -> recupera jobs "running" travados (sem avanço recente)
//      e dispara uma execução por projeto.
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

// Mantém folga sob o limite de execução da Edge Function antes de reencadear.
const MAX_RUNTIME_MS = 100_000;
// Job é considerado travado se não avançou nesse tempo.
const STALE_MS = 2 * 60 * 1000;

const SELF_URL = `${SUPABASE_URL}/functions/v1/process-analysis-step`;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function callInternalStep(projectId: string): Promise<{
  status?: string;
  skipped?: boolean;
  error?: string;
}> {
  const response = await fetch(`${VERCEL_APP_URL}/api/internal/analysis/step`, {
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

async function processProject(projectId: string, startedAt: number): Promise<void> {
  while (Date.now() - startedAt < MAX_RUNTIME_MS) {
    let result: { status?: string; skipped?: boolean; error?: string };
    try {
      result = await callInternalStep(projectId);
    } catch (error) {
      console.error(`[edge] erro ao chamar rota interna (${projectId}):`, error);
      // Reencadeia para tentar de novo após uma pausa.
      await invokeSelf({ projectId });
      return;
    }

    if (result.skipped) {
      await sleep(2000);
      continue;
    }
    if (result.status !== "running") {
      return; // done ou error
    }
  }

  // Estourou o orçamento de tempo: continua numa nova invocação.
  await invokeSelf({ projectId });
}

async function recoverStaleJobs(startedAt: number): Promise<number> {
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const cutoff = new Date(Date.now() - STALE_MS).toISOString();
  const { data: jobs, error } = await admin
    .from("analysis_jobs")
    .select("project_id, updated_at")
    .eq("status", "running")
    .lt("updated_at", cutoff);

  if (error) {
    console.error("[edge] erro ao buscar jobs travados:", error);
    return 0;
  }

  const projectIds = [...new Set((jobs ?? []).map((j) => j.project_id as string))];
  for (const projectId of projectIds) {
    // Cada projeto ganha sua própria invocação (orçamento de tempo isolado).
    if (Date.now() - startedAt < MAX_RUNTIME_MS) {
      await invokeSelf({ projectId });
    }
  }
  return projectIds.length;
}

Deno.serve(async (req) => {
  const startedAt = Date.now();

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { "Content-Type": "application/json" },
    });
  }

  let body: { projectId?: string } = {};
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

  if (body.projectId) {
    await processProject(body.projectId, startedAt);
    return new Response(JSON.stringify({ ok: true, projectId: body.projectId }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  const recovered = await recoverStaleJobs(startedAt);
  return new Response(JSON.stringify({ ok: true, recovered }), {
    headers: { "Content-Type": "application/json" },
  });
});
