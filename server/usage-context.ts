import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Contexto de consumo propagado via AsyncLocalStorage: quem chama a IA define
 * o projeto/feature uma vez (no runner ou na rota), e o anthropic-client lê
 * daqui ao registrar os tokens — sem precisar passar isso por toda assinatura.
 */
export interface UsageContext {
  projectId?: string | null;
  feature: string;
  userId?: string | null;
}

const storage = new AsyncLocalStorage<UsageContext>();

export function runWithUsageContext<T>(
  ctx: UsageContext,
  fn: () => Promise<T>
): Promise<T> {
  return storage.run(ctx, fn);
}

export function getUsageContext(): UsageContext | undefined {
  return storage.getStore();
}
