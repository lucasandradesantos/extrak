import type { ActorSummary } from "../types";

export function formatActor(actor?: ActorSummary | null): string {
  if (!actor?.label) return "—";
  return actor.label;
}

export function formatActorAt(
  actor?: ActorSummary | null,
  at?: string | null
): string {
  if (!actor && !at) return "—";
  const name = formatActor(actor);
  if (!at) return name;
  const when = new Date(at).toLocaleString("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
  return `${name} · ${when}`;
}
