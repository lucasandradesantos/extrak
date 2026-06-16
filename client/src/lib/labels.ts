import type { GapCategoria, GapSeveridade, GapSource, UserRole } from "../types";

export const CATEGORIA_LABELS: Record<GapCategoria, string> = {
  cobertura: "Cobertura",
  metrica_sem_meta: "Métrica sem meta",
  persona_faltante: "Persona faltante",
  inconsistencia: "Inconsistência",
  criterio_nao_testavel: "Critério não testável",
  pergunta_cliente: "Pergunta para o cliente",
  tela_sem_discovery: "Tela sem Discovery",
  discovery_sem_tela: "Discovery sem tela",
  inconsistencia_proto_discovery: "Protótipo × Discovery",
};

export const SOURCE_LABELS: Record<GapSource, string> = {
  discovery: "Discovery",
  prototype: "Protótipo",
  comparacao: "Protótipo × Discovery",
};

export const SEVERIDADE_ORDER: GapSeveridade[] = ["alta", "media", "baixa"];

export const SEVERIDADE_LABELS: Record<GapSeveridade, string> = {
  alta: "Alta",
  media: "Média",
  baixa: "Baixa",
};

export const ROLE_LABELS: Record<UserRole, string> = {
  super_admin: "Super-admin",
  team_admin: "Admin do time",
  member: "Membro",
};
