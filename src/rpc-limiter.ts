import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface RpcLimiterStatus {
  stateFile: string;
  enabled: boolean;
  activeUrl: string;
  mainUrl: string;
  fallbackUrl: string;
  requestsPerSecond: number | null;
  updatedAt: string;
}

function providerUrl(provider: unknown): string {
  if (!provider || typeof provider !== 'object') return '';
  const value = provider as Record<string, unknown>;
  if (typeof value.url === 'string') return value.url;
  if (typeof value.rpcUrl === 'string') return value.rpcUrl;
  if (typeof value.rpcBaseUrl === 'string') {
    const key = typeof value.apiKey === 'string' ? value.apiKey : '';
    return key ? `${value.rpcBaseUrl}${value.rpcBaseUrl.includes('?') ? '&' : '?'}api-key=${key}` : value.rpcBaseUrl;
  }
  return '';
}

export function defaultRpcLimiterStateFile(): string {
  return join(homedir(), '.rpc_limiter', 'state.json');
}

export async function getRpcLimiterStatus(stateFile = defaultRpcLimiterStateFile()): Promise<RpcLimiterStatus> {
  try {
    const state = JSON.parse(await readFile(stateFile, 'utf8')) as Record<string, any>;
    const mainUrl = providerUrl(state.providers?.main) || providerUrl(state);
    const fallbackUrl = providerUrl(state.providers?.fallback);
    const interval = Number(state.buckets?.['rpc:shared']?.intervalMs);
    return {
      stateFile,
      enabled: Boolean(state.enabled && (mainUrl || fallbackUrl)),
      activeUrl: mainUrl || fallbackUrl,
      mainUrl,
      fallbackUrl,
      requestsPerSecond: Number.isFinite(interval) && interval > 0 ? 1000 / interval : null,
      updatedAt: typeof state.updatedAt === 'string' ? state.updatedAt : '',
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { stateFile, enabled: false, activeUrl: '', mainUrl: '', fallbackUrl: '', requestsPerSecond: null, updatedAt: '' };
    }
    throw error;
  }
}

export async function resolveRpcUrl(useRpcLimiter: boolean, directRpcUrl: string): Promise<string> {
  if (!useRpcLimiter) return directRpcUrl;
  const status = await getRpcLimiterStatus();
  if (!status.activeUrl) throw new Error('RPC limiter is enabled, but no Main or Fallback RPC URL is configured.');
  return status.activeUrl;
}
