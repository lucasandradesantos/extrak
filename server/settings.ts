import { getSupabaseAdmin } from "./supabase";

/**
 * Configurações sensíveis armazenadas em public.app_settings (acessível apenas
 * via service_role no backend). Mantém um cache em memória com TTL curto para
 * não consultar o banco a cada chamada da IA.
 */

const CACHE_TTL_MS = 30_000;

interface CacheEntry {
  value: string | null;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();

export async function getSetting(key: string): Promise<string | null> {
  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }

  const admin = getSupabaseAdmin();
  const { data } = await admin
    .from("app_settings")
    .select("value")
    .eq("key", key)
    .maybeSingle();

  const value = data?.value ?? null;
  cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
  return value;
}

export async function setSetting(
  key: string,
  value: string,
  updatedBy?: string | null
): Promise<void> {
  const admin = getSupabaseAdmin();
  await admin.from("app_settings").upsert(
    {
      key,
      value,
      updated_by: updatedBy ?? null,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "key" }
  );
  cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
}

export async function clearSetting(key: string): Promise<void> {
  const admin = getSupabaseAdmin();
  await admin.from("app_settings").delete().eq("key", key);
  cache.delete(key);
}

export const ANTHROPIC_KEY_SETTING = "anthropic_api_key";
