import { Router } from "express";
import {
  type AuthedRequest,
  type UserRole,
  requireAdmin,
  requireAuth,
  requireSuperAdmin,
} from "../auth";
import { getSupabaseAdmin } from "../supabase";
import {
  ANTHROPIC_KEY_SETTING,
  clearSetting,
  getSetting,
  setSetting,
} from "../settings";
import {
  getScopeConfig,
  saveScopeConfig,
  type ScopeConfig,
} from "../scope-service";

export const adminRouter = Router();

/** Mostra só os últimos 4 caracteres da chave; nunca o valor completo. */
function maskKey(value: string): string {
  const tail = value.slice(-4);
  return `••••••••${tail}`;
}

const VALID_ROLES: UserRole[] = ["super_admin", "team_admin", "member"];

function isEmail(value: unknown): value is string {
  return typeof value === "string" && /.+@.+\..+/.test(value);
}

/**
 * Bootstrap do primeiro super-admin. Só funciona quando ainda não existe nenhum
 * super_admin e o segredo confere com ADMIN_BOOTSTRAP_SECRET. Não exige sessão.
 */
adminRouter.post("/bootstrap", async (req, res) => {
  const secret = process.env.ADMIN_BOOTSTRAP_SECRET;

  if (!secret) {
    res.status(500).json({ error: "ADMIN_BOOTSTRAP_SECRET não configurado." });
    return;
  }

  const { secret: provided, email, password, full_name } = req.body as {
    secret?: string;
    email?: string;
    password?: string;
    full_name?: string;
  };

  if (provided !== secret) {
    res.status(403).json({ error: "Segredo de bootstrap inválido." });
    return;
  }

  if (!isEmail(email) || !password || password.length < 8) {
    res.status(400).json({
      error: "Informe um email válido e uma senha com pelo menos 8 caracteres.",
    });
    return;
  }

  const admin = getSupabaseAdmin();

  const { count, error: countError } = await admin
    .from("profiles")
    .select("id", { count: "exact", head: true })
    .eq("role", "super_admin");

  if (countError) {
    res.status(500).json({ error: "Erro ao verificar administradores existentes." });
    return;
  }

  if ((count ?? 0) > 0) {
    res.status(409).json({ error: "Já existe um super-admin. Bootstrap desabilitado." });
    return;
  }

  const created = await createUserWithProfile(admin, {
    email,
    password,
    full_name: full_name ?? null,
    team_id: null,
    role: "super_admin",
  });

  if ("error" in created) {
    res.status(created.status).json({ error: created.error });
    return;
  }

  res.status(201).json({ user: created.user });
});

// A partir daqui, todas as rotas exigem autenticação + papel de admin.
adminRouter.use(requireAuth);

// ----- TIMES -----

adminRouter.get("/teams", requireAdmin, async (req: AuthedRequest, res) => {
  const admin = getSupabaseAdmin();
  const isSuper = req.profile?.role === "super_admin";

  let query = admin.from("teams").select("id, name, created_at").order("name");
  if (!isSuper && req.profile?.team_id) {
    query = query.eq("id", req.profile.team_id);
  }

  const { data, error } = await query;
  if (error) {
    res.status(500).json({ error: "Erro ao listar times." });
    return;
  }
  res.json({ teams: data ?? [] });
});

adminRouter.post("/teams", requireSuperAdmin, async (req, res) => {
  const { name } = req.body as { name?: string };
  if (!name || !name.trim()) {
    res.status(400).json({ error: "Nome do time é obrigatório." });
    return;
  }

  const admin = getSupabaseAdmin();
  const { data, error } = await admin
    .from("teams")
    .insert({ name: name.trim() })
    .select("id, name, created_at")
    .single();

  if (error) {
    res.status(500).json({ error: "Erro ao criar time." });
    return;
  }
  res.status(201).json({ team: data });
});

// ----- USUÁRIOS -----

adminRouter.get("/users", requireAdmin, async (req: AuthedRequest, res) => {
  const admin = getSupabaseAdmin();
  const isSuper = req.profile?.role === "super_admin";

  let query = admin
    .from("profiles")
    .select("id, full_name, team_id, role, created_at")
    .order("created_at", { ascending: false });

  if (!isSuper) {
    if (!req.profile?.team_id) {
      res.json({ users: [] });
      return;
    }
    query = query.eq("team_id", req.profile.team_id);
  }

  const { data: profiles, error } = await query;
  if (error) {
    res.status(500).json({ error: "Erro ao listar usuários." });
    return;
  }

  // Busca emails via Admin API e mapeia por id.
  const { data: list } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
  const emailById = new Map((list?.users ?? []).map((u) => [u.id, u.email]));

  const users = (profiles ?? []).map((p) => ({
    ...p,
    email: emailById.get(p.id) ?? null,
  }));

  res.json({ users });
});

adminRouter.post("/users", requireAdmin, async (req: AuthedRequest, res) => {
  const { email, password, full_name, team_id, role } = req.body as {
    email?: string;
    password?: string;
    full_name?: string;
    team_id?: string;
    role?: UserRole;
  };

  if (!isEmail(email) || !password || password.length < 8) {
    res.status(400).json({
      error: "Informe um email válido e uma senha com pelo menos 8 caracteres.",
    });
    return;
  }

  const requestedRole: UserRole = role && VALID_ROLES.includes(role) ? role : "member";
  const isSuper = req.profile?.role === "super_admin";

  let targetTeamId: string | null = team_id ?? null;

  if (isSuper) {
    // super_admin pode criar em qualquer time; super_admin sem time é permitido.
    if (requestedRole !== "super_admin" && !targetTeamId) {
      res.status(400).json({ error: "Selecione um time para o usuário." });
      return;
    }
  } else {
    // team_admin só cria dentro do próprio time e não pode criar super_admin.
    if (requestedRole === "super_admin") {
      res.status(403).json({ error: "Você não pode criar super-admins." });
      return;
    }
    targetTeamId = req.profile?.team_id ?? null;
    if (!targetTeamId) {
      res.status(400).json({ error: "Seu usuário não está associado a um time." });
      return;
    }
  }

  const admin = getSupabaseAdmin();
  const created = await createUserWithProfile(admin, {
    email,
    password,
    full_name: full_name ?? null,
    team_id: targetTeamId,
    role: requestedRole,
  });

  if ("error" in created) {
    res.status(created.status).json({ error: created.error });
    return;
  }

  res.status(201).json({ user: created.user });
});

adminRouter.delete("/users/:id", requireAdmin, async (req: AuthedRequest, res) => {
  const targetId = String(req.params.id);
  if (targetId === req.authUser?.id) {
    res.status(400).json({ error: "Você não pode remover a si mesmo." });
    return;
  }

  const admin = getSupabaseAdmin();
  const { data: target, error: targetError } = await admin
    .from("profiles")
    .select("id, team_id, role")
    .eq("id", targetId)
    .single();

  if (targetError || !target) {
    res.status(404).json({ error: "Usuário não encontrado." });
    return;
  }

  const isSuper = req.profile?.role === "super_admin";
  if (!isSuper) {
    if (target.role === "super_admin" || target.team_id !== req.profile?.team_id) {
      res.status(403).json({ error: "Você não pode remover este usuário." });
      return;
    }
  }

  // Apagar o auth user remove o profile via ON DELETE CASCADE.
  const { error: delError } = await admin.auth.admin.deleteUser(targetId);
  if (delError) {
    res.status(500).json({ error: "Erro ao remover usuário." });
    return;
  }

  res.json({ ok: true });
});

// ----- CONFIGURAÇÕES (chave da API Claude) -----

// Status da chave: configurada? de onde vem? (valor sempre mascarado).
adminRouter.get(
  "/settings/anthropic",
  requireSuperAdmin,
  async (_req: AuthedRequest, res) => {
    let dbKey: string | null = null;
    try {
      dbKey = await getSetting(ANTHROPIC_KEY_SETTING);
    } catch {
      dbKey = null;
    }
    const envKey = process.env.ANTHROPIC_API_KEY;
    const hasEnv = Boolean(envKey && envKey !== "sua_chave_anthropic_aqui");

    if (dbKey && dbKey.trim()) {
      res.json({ configured: true, source: "db", masked: maskKey(dbKey.trim()) });
      return;
    }
    if (hasEnv) {
      res.json({ configured: true, source: "env", masked: maskKey(envKey!) });
      return;
    }
    res.json({ configured: false, source: null, masked: null });
  }
);

// Define/atualiza a chave da API Claude no banco (sobrepõe a env).
adminRouter.put(
  "/settings/anthropic",
  requireSuperAdmin,
  async (req: AuthedRequest, res) => {
    const { apiKey } = req.body as { apiKey?: string };
    const value = typeof apiKey === "string" ? apiKey.trim() : "";

    if (!value || value.length < 20 || !value.startsWith("sk-")) {
      res.status(400).json({
        error: 'Chave inválida. Cole a chave da Anthropic completa (começa com "sk-").',
      });
      return;
    }

    await setSetting(ANTHROPIC_KEY_SETTING, value, req.authUser?.id);
    res.json({ configured: true, source: "db", masked: maskKey(value) });
  }
);

// Remove a chave do banco (volta a usar a variável de ambiente, se houver).
adminRouter.delete(
  "/settings/anthropic",
  requireSuperAdmin,
  async (_req: AuthedRequest, res) => {
    await clearSetting(ANTHROPIC_KEY_SETTING);
    const envKey = process.env.ANTHROPIC_API_KEY;
    const hasEnv = Boolean(envKey && envKey !== "sua_chave_anthropic_aqui");
    res.json({
      configured: hasEnv,
      source: hasEnv ? "env" : null,
      masked: hasEnv ? maskKey(envKey!) : null,
    });
  }
);

// Configuração global da calculadora de escopo (hourly rate, multiplicadores,
// buffers, faixas de complexidade, fases). Leitura para qualquer usuário autenticado.
adminRouter.get("/settings/scope", async (_req: AuthedRequest, res) => {
  const config = await getScopeConfig();
  res.json({ config });
});

adminRouter.put(
  "/settings/scope",
  requireSuperAdmin,
  async (req: AuthedRequest, res) => {
    const { config } = req.body as { config?: Partial<ScopeConfig> };
    if (!config || typeof config !== "object") {
      res.status(400).json({ error: "Configuração inválida." });
      return;
    }
    const saved = await saveScopeConfig(config, req.authUser?.id);
    res.json({ config: saved });
  }
);

// ----- helper -----

interface CreateUserInput {
  email: string;
  password: string;
  full_name: string | null;
  team_id: string | null;
  role: UserRole;
}

type CreateUserResult =
  | { user: { id: string; email: string; full_name: string | null; team_id: string | null; role: UserRole } }
  | { error: string; status: number };

async function createUserWithProfile(
  admin: ReturnType<typeof getSupabaseAdmin>,
  input: CreateUserInput
): Promise<CreateUserResult> {
  const { data, error } = await admin.auth.admin.createUser({
    email: input.email,
    password: input.password,
    email_confirm: true,
    user_metadata: { full_name: input.full_name },
  });

  if (error || !data.user) {
    const message = error?.message ?? "Erro ao criar usuário.";
    const status = /already|registered|exists/i.test(message) ? 409 : 500;
    return { error: message, status };
  }

  const { error: profileError } = await admin.from("profiles").insert({
    id: data.user.id,
    full_name: input.full_name,
    team_id: input.team_id,
    role: input.role,
  });

  if (profileError) {
    // Rollback do auth user para não deixar conta órfã.
    await admin.auth.admin.deleteUser(data.user.id);
    return { error: "Erro ao criar o perfil do usuário.", status: 500 };
  }

  return {
    user: {
      id: data.user.id,
      email: input.email,
      full_name: input.full_name,
      team_id: input.team_id,
      role: input.role,
    },
  };
}
