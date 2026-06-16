import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const url = process.env.SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

let cached: SupabaseClient | null = null;

/**
 * Cliente Supabase com a service_role key. Bypassa RLS, então só deve ser usado
 * no servidor e após a autorização do usuário ter sido verificada.
 */
export function getSupabaseAdmin(): SupabaseClient {
  if (!url || !serviceRoleKey) {
    throw new Error(
      "Supabase não configurado: defina SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY."
    );
  }

  if (!cached) {
    cached = createClient(url, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
  }

  return cached;
}

export function isSupabaseConfigured(): boolean {
  return Boolean(url && serviceRoleKey);
}
