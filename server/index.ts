import "dotenv/config";
import cors from "cors";
import express from "express";
import { type AuthedRequest, requireAuth } from "./auth";
import { adminRouter } from "./routes/admin";
import { analysisRouter } from "./routes/analysis";
import { projectsRouter } from "./routes/projects";
import { isSupabaseConfigured } from "./supabase";

const app = express();
const PORT = process.env.PORT ?? 3001;

app.use(cors());
app.use(express.json({ limit: "25mb" }));

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, supabase: isSupabaseConfigured() });
});

// Perfil do usuário autenticado (papel + time) para o frontend.
app.get("/api/me", requireAuth, (req: AuthedRequest, res) => {
  res.json({ profile: req.profile, email: req.authUser?.email });
});

// Admin: o /bootstrap é público; as demais rotas exigem auth (tratado no router).
app.use("/api/admin", adminRouter);

// Projetos e análise exigem usuário autenticado (middleware aplicado uma vez).
app.use("/api/projects", requireAuth);
app.use("/api/projects", projectsRouter);
app.use("/api/projects", analysisRouter);

// Handler de erro genérico (evita vazar stack e responde JSON).
app.use(
  (
    err: unknown,
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction
  ) => {
    console.error("Erro não tratado:", err);
    if (res.headersSent) return;
    res.status(500).json({ error: "Erro interno do servidor." });
  }
);

// Na Vercel o app roda como serverless function (sem servidor persistente).
// Localmente, sobe o servidor HTTP normalmente.
if (!process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

export default app;
