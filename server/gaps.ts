import { createHash } from "node:crypto";
import {
  Gap,
  GapCategoria,
  GapDiff,
  GapSeveridade,
  GapSource,
  GapStatus,
} from "./types";

const CATEGORIAS: GapCategoria[] = [
  "cobertura",
  "metrica_sem_meta",
  "persona_faltante",
  "inconsistencia",
  "criterio_nao_testavel",
  "pergunta_cliente",
  "tela_sem_discovery",
  "discovery_sem_tela",
  "inconsistencia_proto_discovery",
];

const SEVERIDADES: GapSeveridade[] = ["alta", "media", "baixa"];

const SOURCES: GapSource[] = ["discovery", "prototype", "comparacao"];

/**
 * Origem do gap derivada da categoria — deixa explícito para o time de design
 * de onde o gap nasce:
 * - tela_sem_discovery → existe no Protótipo, falta no Discovery → "prototype"
 * - discovery_sem_tela → existe no Discovery, falta tela → "discovery"
 * - inconsistencia_proto_discovery → conflito entre os dois → "comparacao"
 */
const CATEGORIA_SOURCE: Partial<Record<GapCategoria, GapSource>> = {
  tela_sem_discovery: "prototype",
  discovery_sem_tela: "discovery",
  inconsistencia_proto_discovery: "comparacao",
};

/**
 * ID estável baseado em hash da chave (localizacao | categoria | titulo),
 * nunca em ordem de aparição. Garante que o mesmo gap mantenha o mesmo ID
 * entre reprocessamentos, permitindo o diff honesto.
 */
export function computeGapId(chave: string): string {
  return createHash("sha1")
    .update(chave.trim().toLowerCase())
    .digest("hex")
    .slice(0, 12);
}

function normalizeChave(gap: Partial<Gap>): string {
  if (gap.chave && gap.chave.trim()) {
    return gap.chave.trim();
  }
  return [gap.localizacao, gap.categoria, gap.titulo]
    .filter(Boolean)
    .join(" | ");
}

function coerceCategoria(value: unknown): GapCategoria {
  return CATEGORIAS.includes(value as GapCategoria)
    ? (value as GapCategoria)
    : "cobertura";
}

function coerceSeveridade(value: unknown): GapSeveridade {
  return SEVERIDADES.includes(value as GapSeveridade)
    ? (value as GapSeveridade)
    : "media";
}

function coerceStatus(value: unknown): GapStatus {
  return value === "resolvido" ? "resolvido" : "aberto";
}

function coerceSource(value: unknown, categoria: GapCategoria): GapSource {
  // Para categorias de comparação a origem é determinística pela categoria
  // (ignora o "comparacao" genérico que a IA manda, para distinguir a fonte).
  const derived = CATEGORIA_SOURCE[categoria];
  if (derived) return derived;
  if (SOURCES.includes(value as GapSource)) {
    return value as GapSource;
  }
  return "discovery";
}

/**
 * Normaliza os gaps crus vindos da IA: garante chave/ID estável, valores de
 * enum válidos e campos obrigatórios. Deduplica por ID.
 */
export function normalizeGaps(rawGaps: unknown): Gap[] {
  if (!Array.isArray(rawGaps)) return [];

  const byId = new Map<string, Gap>();

  for (const raw of rawGaps) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;

    const chave = normalizeChave({
      chave: typeof r.chave === "string" ? r.chave : undefined,
      localizacao: typeof r.localizacao === "string" ? r.localizacao : undefined,
      categoria: r.categoria as GapCategoria | undefined,
      titulo: typeof r.titulo === "string" ? r.titulo : undefined,
    });

    if (!chave) continue;

    const id = computeGapId(chave);
    const categoria = coerceCategoria(r.categoria);

    const gap: Gap = {
      id,
      chave,
      categoria,
      severidade: coerceSeveridade(r.severidade),
      localizacao: typeof r.localizacao === "string" ? r.localizacao : "—",
      titulo: typeof r.titulo === "string" ? r.titulo : chave,
      descricao: typeof r.descricao === "string" ? r.descricao : "",
      sugestao: typeof r.sugestao === "string" ? r.sugestao : "",
      status: coerceStatus(r.status),
      source: coerceSource(r.source, categoria),
    };

    byId.set(id, gap);
  }

  return [...byId.values()];
}

/**
 * Compara o conjunto anterior com o novo por ID estável:
 * - resolvidos: existiam antes e sumiram agora (ou vieram marcados resolvido)
 * - novos: aparecem só agora
 * - abertos: continuam presentes em ambos
 */
export function diffGaps(previous: Gap[], next: Gap[]): GapDiff {
  const prevIds = new Set(previous.map((g) => g.id));
  const nextOpen = next.filter((g) => g.status !== "resolvido");
  const nextOpenIds = new Set(nextOpen.map((g) => g.id));

  const resolvidos = previous
    .filter((g) => !nextOpenIds.has(g.id))
    .map((g) => g.id);

  const novos = nextOpen
    .filter((g) => !prevIds.has(g.id))
    .map((g) => g.id);

  const abertos = nextOpen
    .filter((g) => prevIds.has(g.id))
    .map((g) => g.id);

  return { resolvidos, novos, abertos };
}
