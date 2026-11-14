import { AsyncLocalStorage } from "node:async_hooks";
import { env } from "cloudflare:workers";

const origins = new AsyncLocalStorage<string>();

export function withRequestOrigin<T>(origin: string, run: () => T): T {
  return origins.run(origin, run);
}

export function setupUrl(): string {
  return env.PUBLIC_BASE_URL || origins.getStore() || "/";
}
