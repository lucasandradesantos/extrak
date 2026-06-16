import { createClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const publishableKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as
  | string
  | undefined;

if (!url || !publishableKey) {
  // Em produção, garanta VITE_SUPABASE_URL e VITE_SUPABASE_PUBLISHABLE_KEY.
  console.error(
    "Supabase não configurado no frontend: defina VITE_SUPABASE_URL e VITE_SUPABASE_PUBLISHABLE_KEY."
  );
}

export const supabase = createClient(url ?? "", publishableKey ?? "");
