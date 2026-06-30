import type { Session } from "@supabase/supabase-js";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { apiFetch } from "../lib/api";
import { supabase } from "../lib/supabase";
import type { Profile } from "../types";

interface AuthState {
  session: Session | null;
  profile: Profile | null;
  email: string | null;
  loading: boolean;
  signIn: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
  reloadProfile: () => Promise<void>;
  isAdmin: boolean;
}

const AuthContext = createContext<AuthState | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [email, setEmail] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const loadProfile = useCallback(async (active: Session | null) => {
    if (!active) {
      setProfile(null);
      setEmail(null);
      return;
    }
    try {
      const me = await apiFetch<{ profile: Profile; email: string }>("/api/me", {
        fallback: "Erro ao carregar perfil.",
      });
      setProfile(me.profile);
      setEmail(me.email);
    } catch {
      setProfile(null);
    }
  }, []);

  useEffect(() => {
    let mounted = true;

    supabase.auth.getSession().then(async ({ data }) => {
      if (!mounted) return;
      setSession(data.session);
      await loadProfile(data.session);
      setLoading(false);
    });

    const { data: sub } = supabase.auth.onAuthStateChange((_event, newSession) => {
      setSession(newSession);
      loadProfile(newSession);
    });

    return () => {
      mounted = false;
      sub.subscription.unsubscribe();
    };
  }, [loadProfile]);

  const signIn = useCallback(async (mail: string, password: string) => {
    const { error } = await supabase.auth.signInWithPassword({
      email: mail,
      password,
    });
    if (error) {
      throw new Error(
        error.message === "Invalid login credentials"
          ? "Email ou senha incorretos."
          : error.message
      );
    }
  }, []);

  const signOut = useCallback(async () => {
    await supabase.auth.signOut();
    setProfile(null);
    setEmail(null);
  }, []);

  const reloadProfile = useCallback(
    () => loadProfile(session),
    [loadProfile, session]
  );

  const value = useMemo<AuthState>(
    () => ({
      session,
      profile,
      email,
      loading,
      signIn,
      signOut,
      reloadProfile,
      isAdmin:
        profile?.role === "super_admin" || profile?.role === "team_admin",
    }),
    [session, profile, email, loading, signIn, signOut, reloadProfile]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth deve ser usado dentro de AuthProvider.");
  return ctx;
}
