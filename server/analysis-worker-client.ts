import { runAnalysisStep } from "./analysis-runner";

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

/**
 * Dispara o worker de análise. Em produção invoca a Edge Function do Supabase
 * (que reencadeia bloco a bloco mesmo com a aba do usuário fechada). Sem a
 * Edge Function configurada (ex.: dev local), encadeia os passos no servidor.
 * Nunca bloqueia o request que chamou — apenas inicia o processamento.
 */
export function scheduleAnalysisWorker(projectId: string): void {
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
      body: JSON.stringify({ projectId }),
    }).catch((error) => {
      console.error(
        "[worker] Falha ao invocar Edge Function; usando fallback no servidor:",
        error
      );
      void chainAnalysisOnServer(projectId);
    });
    return;
  }

  void chainAnalysisOnServer(projectId);
}

/**
 * Fallback: encadeia os passos no próprio processo Node. Usado em dev local ou
 * quando a Edge Function não está configurada. Em serverless puro este loop só
 * sobrevive enquanto a função estiver viva, por isso o pg_cron é a rede de
 * segurança que retoma jobs interrompidos.
 */
export async function chainAnalysisOnServer(projectId: string): Promise<void> {
  const secret = workerSecret();
  const maxSteps = 1000;

  for (let i = 0; i < maxSteps; i++) {
    if (secret) {
      try {
        const response = await fetch(`${internalBaseUrl()}/api/internal/analysis/step`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Worker-Secret": secret,
          },
          body: JSON.stringify({ projectId }),
        });
        const result = (await response.json()) as {
          status?: string;
          skipped?: boolean;
        };
        if (result.skipped) {
          await sleep(1500);
          continue;
        }
        if (result.status !== "running") return;
        continue;
      } catch (error) {
        console.error("[worker] Falha na rota interna; processando inline:", error);
      }
    }

    // Sem secret ou falha na rota interna: processa direto no processo.
    const result = await runAnalysisStep(projectId, { force: !secret });
    if (result.skipped) {
      await sleep(1500);
      continue;
    }
    if (result.status !== "running") return;
  }
}
