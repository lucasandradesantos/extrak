import { getSupabaseAdmin } from "./supabase";

export interface ActorSummary {
  id: string;
  full_name: string | null;
  email: string | null;
  label: string;
}

/** Resolve nomes e e-mails de usuários para exibir no histórico. */
export async function resolveActors(
  ids: Array<string | null | undefined>
): Promise<Record<string, ActorSummary>> {
  const unique = [...new Set(ids.filter((id): id is string => Boolean(id)))];
  if (unique.length === 0) return {};

  const admin = getSupabaseAdmin();
  const { data: profiles } = await admin
    .from("profiles")
    .select("id, full_name")
    .in("id", unique);

  const profileById = new Map(
    (profiles ?? []).map((p) => [p.id as string, p.full_name as string | null])
  );

  const result: Record<string, ActorSummary> = {};

  await Promise.all(
    unique.map(async (id) => {
      let email: string | null = null;
      try {
        const { data } = await admin.auth.admin.getUserById(id);
        email = data.user?.email ?? null;
      } catch {
        // Ignora falha pontual ao buscar e-mail.
      }

      const full_name = profileById.get(id) ?? null;
      result[id] = {
        id,
        full_name,
        email,
        label: full_name?.trim() || email || "Usuário",
      };
    })
  );

  return result;
}

export function pickActor(
  actors: Record<string, ActorSummary>,
  id: string | null | undefined
): ActorSummary | null {
  if (!id) return null;
  return actors[id] ?? null;
}

export function attachActors<T extends Record<string, unknown>>(
  row: T,
  actors: Record<string, ActorSummary>,
  fields: Array<{ idKey: keyof T; outKey: string }>
): T & Record<string, unknown> {
  const out: Record<string, unknown> = { ...row };
  for (const { idKey, outKey } of fields) {
    const actorId = row[idKey];
    out[outKey] =
      typeof actorId === "string" ? pickActor(actors, actorId) : null;
  }
  return out as T & Record<string, unknown>;
}
