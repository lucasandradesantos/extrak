import type { NextFunction, Request, Response } from "express";
import { getSupabaseAdmin } from "./supabase";

export type UserRole = "super_admin" | "team_admin" | "member";

export interface Profile {
  id: string;
  full_name: string | null;
  team_id: string | null;
  role: UserRole;
}

export interface AuthedRequest extends Request {
  authUser?: { id: string; email?: string };
  profile?: Profile;
}

function extractToken(req: Request): string | null {
  const header = req.headers.authorization;
  if (header && header.startsWith("Bearer ")) {
    return header.slice(7).trim();
  }
  return null;
}

/**
 * Valida o JWT do Supabase (header Authorization: Bearer) e carrega o profile
 * (papel + time) do usuário. Bloqueia se não autenticado ou sem profile.
 */
export async function requireAuth(
  req: AuthedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  const token = extractToken(req);

  if (!token) {
    res.status(401).json({ error: "Não autenticado." });
    return;
  }

  const admin = getSupabaseAdmin();

  const { data: userData, error: userError } = await admin.auth.getUser(token);

  if (userError || !userData.user) {
    res.status(401).json({ error: "Sessão inválida ou expirada." });
    return;
  }

  const { data: profile, error: profileError } = await admin
    .from("profiles")
    .select("id, full_name, team_id, role")
    .eq("id", userData.user.id)
    .single();

  if (profileError || !profile) {
    res.status(403).json({
      error: "Perfil não encontrado. Solicite acesso a um administrador.",
    });
    return;
  }

  req.authUser = { id: userData.user.id, email: userData.user.email };
  req.profile = profile as Profile;
  next();
}

/** Exige papel super_admin. Deve rodar depois de requireAuth. */
export function requireSuperAdmin(
  req: AuthedRequest,
  res: Response,
  next: NextFunction
): void {
  if (req.profile?.role !== "super_admin") {
    res.status(403).json({ error: "Acesso restrito ao super-admin." });
    return;
  }
  next();
}

/** Exige papel super_admin ou team_admin. Deve rodar depois de requireAuth. */
export function requireAdmin(
  req: AuthedRequest,
  res: Response,
  next: NextFunction
): void {
  const role = req.profile?.role;
  if (role !== "super_admin" && role !== "team_admin") {
    res.status(403).json({ error: "Acesso restrito a administradores." });
    return;
  }
  next();
}
