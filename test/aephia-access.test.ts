import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isFreshValidAephiaAccess,
  validateAephiaApiKey,
  type AephiaFetch,
} from '../src/aephia-access.js';

function response(status: number, statusText = ''): Response {
  return { status, statusText } as Response;
}

test('validates an Aephia API key with the established GET bearer contract', async () => {
  const requests: Array<{ input: string | URL | Request; init?: RequestInit }> = [];
  const fetcher: AephiaFetch = async (input, init) => {
    requests.push({ input, init });
    return response(204);
  };

  const result = await validateAephiaApiKey('  secret-token  ', fetcher, 10_000, 123_000);

  assert.deepEqual(result, {
    status: 'valid',
    message: 'Aephia API key is valid and active.',
    checkedAt: 123_000,
  });
  const request = requests[0];
  assert.equal(String(request.input), 'https://api.aephia.com/token/validate');
  assert.equal(request.init?.method, 'GET');
  assert.equal((request.init?.headers as Record<string, string>).Authorization, 'Bearer secret-token');
  assert.ok(request.init?.signal instanceof AbortSignal);
});

test('keeps the app locked for missing, rejected, and unavailable validation', async () => {
  assert.equal((await validateAephiaApiKey('', async () => response(204))).status, 'missing');
  assert.equal((await validateAephiaApiKey('bad', async () => response(401))).status, 'invalid');
  assert.equal((await validateAephiaApiKey('token', async () => response(405))).status, 'temporary_error');
  assert.equal((await validateAephiaApiKey('token', async () => response(503))).status, 'temporary_error');
  assert.equal((await validateAephiaApiKey('token', async () => { throw new Error('offline'); })).status, 'temporary_error');
});

test('only a recent successful validation unlocks protected behavior', () => {
  assert.equal(isFreshValidAephiaAccess({ status: 'valid', message: '', checkedAt: 100_000 }, 399_999), true);
  assert.equal(isFreshValidAephiaAccess({ status: 'valid', message: '', checkedAt: 100_000 }, 400_001), false);
  assert.equal(isFreshValidAephiaAccess({ status: 'invalid', message: '', checkedAt: 399_999 }, 400_000), false);
});
