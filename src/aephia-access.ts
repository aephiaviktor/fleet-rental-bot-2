export const AEPHIA_TOKEN_VALIDATE_URL = 'https://api.aephia.com/token/validate';
export const AEPHIA_VALIDATION_TTL_MS = 5 * 60 * 1_000;

export type AephiaAccessStatus = 'missing' | 'checking' | 'valid' | 'invalid' | 'temporary_error';

export interface AephiaAccessResult {
  status: AephiaAccessStatus;
  message: string;
  checkedAt: number;
}

export type AephiaFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export async function validateAephiaApiKey(
  apiKey: string,
  fetcher: AephiaFetch = fetch,
  timeoutMs = 10_000,
  nowMs = Date.now(),
): Promise<AephiaAccessResult> {
  const token = String(apiKey || '').trim();
  if (!token) {
    return { status: 'missing', message: 'First, enter your Aephia API key.', checkedAt: nowMs };
  }

  try {
    const response = await fetcher(AEPHIA_TOKEN_VALIDATE_URL, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (response.status === 204) {
      return { status: 'valid', message: 'Aephia API key is valid and active.', checkedAt: nowMs };
    }
    if (response.status === 401) {
      return {
        status: 'invalid',
        message: 'Aephia API key is invalid, disabled, or expired. Refresh or reclaim it and try again.',
        checkedAt: nowMs,
      };
    }
    if (response.status === 405) {
      return {
        status: 'temporary_error',
        message: 'Aephia validation rejected the request method. Please update Fleet Rental Bot 2.',
        checkedAt: nowMs,
      };
    }
    if (response.status >= 500) {
      return {
        status: 'temporary_error',
        message: 'Aephia verification is temporarily unavailable. Retry shortly.',
        checkedAt: nowMs,
      };
    }
    return {
      status: 'temporary_error',
      message: `Unexpected Aephia validation response: HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ''}.`,
      checkedAt: nowMs,
    };
  } catch {
    return {
      status: 'temporary_error',
      message: 'Could not reach Aephia verification. Check the network and retry.',
      checkedAt: nowMs,
    };
  }
}

export function isFreshValidAephiaAccess(
  result: AephiaAccessResult,
  nowMs = Date.now(),
  ttlMs = AEPHIA_VALIDATION_TTL_MS,
): boolean {
  return result.status === 'valid' && nowMs - result.checkedAt <= ttlMs;
}
