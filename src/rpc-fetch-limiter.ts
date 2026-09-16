import { AsyncLocalStorage } from 'node:async_hooks';
import { deferNormalRpcUntil, deferRpcUntil, recordRpcUsageAttempt, tryClaimRpcSlot } from './fleet-database.js';

type FetchImplementation = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

interface LimitedFetchDependencies {
  now?: () => number;
  sleep?: (delayMs: number) => Promise<void>;
  maxReadAttempts?: number;
}

const rpcPriority = new AsyncLocalStorage<'normal' | 'urgent'>();

export async function withUrgentRpcPriority<T>(databasePath: string, operation: () => Promise<T>): Promise<T> {
  deferNormalRpcUntil(databasePath, Date.now() + 30_000);
  return rpcPriority.run('urgent', operation);
}

function rpcMethod(init?: RequestInit): string | null {
  if (typeof init?.body !== 'string') return null;
  try {
    const payload = JSON.parse(init.body) as { jsonrpc?: unknown; method?: unknown };
    return payload.jsonrpc === '2.0' && typeof payload.method === 'string' ? payload.method : null;
  } catch {
    return null;
  }
}

function safeRpcMethod(method: string): string {
  return /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(method) ? method : 'unknown';
}

function rpcProvider(input: RequestInfo | URL): string {
  try {
    const value = input instanceof Request ? input.url : String(input);
    return new URL(value).hostname === 'sender.helius-rpc.com' ? 'Helius Sender' : 'Direct RPC';
  } catch {
    return 'Direct RPC';
  }
}

function retryAfterMs(response: Response, nowMs: number): number | null {
  const value = response.headers.get('retry-after');
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1_000);
  const dateMs = Date.parse(value);
  return Number.isFinite(dateMs) ? Math.max(0, dateMs - nowMs) : null;
}

export function createLimitedRpcFetch(
  databasePath: string,
  instance: string,
  fetchImplementation: FetchImplementation = globalThis.fetch.bind(globalThis),
  dependencies: LimitedFetchDependencies = {},
): FetchImplementation {
  const now = dependencies.now ?? Date.now;
  const sleep = dependencies.sleep ?? ((delayMs: number) => new Promise((resolve) => setTimeout(resolve, delayMs)));
  const maxReadAttempts = dependencies.maxReadAttempts ?? 3;

  return async (input, init) => {
    const parsedMethod = rpcMethod(init);
    if (!parsedMethod) return fetchImplementation(input, init);
    const method = safeRpcMethod(parsedMethod);
    const provider = rpcProvider(input);
    const mayRetry = method !== 'sendTransaction';
    const attempts = mayRetry ? maxReadAttempts : 1;
    let response: Response | null = null;

    for (let attempt = 0; attempt < attempts; attempt += 1) {
      for (;;) {
        const claim = tryClaimRpcSlot(databasePath, now(), rpcPriority.getStore() === 'urgent');
        if (claim.claimed) break;
        await sleep(Math.max(1, claim.waitMs));
      }
      const responsePromise = fetchImplementation(input, init);
      try {
        recordRpcUsageAttempt(databasePath, instance, method, provider, attempt > 0, now());
      } catch {
        // Usage telemetry must never change RPC behavior after a wire attempt starts.
      }
      response = await responsePromise;
      if (response.status !== 429) return response;

      const delayMs = retryAfterMs(response, now()) ?? Math.min(30_000, 1_000 * (2 ** attempt));
      deferRpcUntil(databasePath, now() + delayMs);
      if (!mayRetry || attempt === attempts - 1) return response;
      await response.body?.cancel().catch(() => {});
    }
    return response!;
  };
}

const INSTALLATION_MARK = Symbol.for('fleet-rental-bot-2.rpc-fetch-limiter');

export function installLimitedRpcFetch(databasePath: string, instance: string): void {
  const state = globalThis as typeof globalThis & { [INSTALLATION_MARK]?: boolean };
  if (state[INSTALLATION_MARK]) return;
  globalThis.fetch = createLimitedRpcFetch(databasePath, instance, globalThis.fetch.bind(globalThis));
  state[INSTALLATION_MARK] = true;
}
