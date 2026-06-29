import { Router, type Request } from "express";
import { runAnalysisStep } from "../analysis-runner";
import { runPrdStep } from "../prd-runner";
import { runScopeStep } from "../scope-runner";

export const internalRouter = Router();

/** Autoriza chamadas do worker via segredo compartilhado (não usa JWT de usuário). */
function authorizeWorker(req: Request): boolean {
  const secret = process.env.ANALYSIS_WORKER_SECRET?.trim();
  if (!secret) return false;
  const header = req.headers["x-worker-secret"];
  return typeof header === "string" && header === secret;
}

/**
 * Processa UM bloco da análise de um projeto. Chamado pela Edge Function do
 * Supabase (ou pelo fallback local). O encadeamento (chamar de novo até o job
 * terminar) é responsabilidade de quem chama, para não duplicar o processamento.
 */
internalRouter.post("/analysis/step", async (req, res) => {
  if (!authorizeWorker(req)) {
    res.status(401).json({ error: "Não autorizado." });
    return;
  }

  const { projectId, force } = req.body as { projectId?: string; force?: boolean };

  if (!projectId || typeof projectId !== "string") {
    res.status(400).json({ error: "projectId é obrigatório." });
    return;
  }

  try {
    const result = await runAnalysisStep(projectId, { force: Boolean(force) });
    res.json(result);
  } catch (error) {
    console.error("[internal/analysis/step] Erro:", error);
    res.status(500).json({
      error: error instanceof Error ? error.message : "Erro ao processar passo.",
    });
  }
});

/** Processa UM passo da geração de PRD (worker no backend). */
internalRouter.post("/prd/step", async (req, res) => {
  if (!authorizeWorker(req)) {
    res.status(401).json({ error: "Não autorizado." });
    return;
  }

  const { projectId, force } = req.body as { projectId?: string; force?: boolean };

  if (!projectId || typeof projectId !== "string") {
    res.status(400).json({ error: "projectId é obrigatório." });
    return;
  }

  try {
    const result = await runPrdStep(projectId, { force: Boolean(force) });
    res.json(result);
  } catch (error) {
    console.error("[internal/prd/step] Erro:", error);
    res.status(500).json({
      error: error instanceof Error ? error.message : "Erro ao processar passo do PRD.",
    });
  }
});

/** Processa UM passo da geração de Escopo (worker no backend). */
internalRouter.post("/scope/step", async (req, res) => {
  if (!authorizeWorker(req)) {
    res.status(401).json({ error: "Não autorizado." });
    return;
  }

  const { projectId, force } = req.body as { projectId?: string; force?: boolean };

  if (!projectId || typeof projectId !== "string") {
    res.status(400).json({ error: "projectId é obrigatório." });
    return;
  }

  try {
    const result = await runScopeStep(projectId, { force: Boolean(force) });
    res.json(result);
  } catch (error) {
    console.error("[internal/scope/step] Erro:", error);
    res.status(500).json({
      error: error instanceof Error ? error.message : "Erro ao processar passo do escopo.",
    });
  }
});
