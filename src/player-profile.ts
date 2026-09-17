import { requireSolanaAddress } from './solana-address.js';
import type { AppSettings } from './settings-store.js';

export const PLAYER_PROFILE_PROGRAM_ID = 'pprofELXjL5Kck7Jn5hCpwAL82DpTkSYBENzahVtbc9';

const PLAYER_PROFILE_DISCRIMINATOR = Uint8Array.from([184, 101, 165, 188, 95, 63, 127, 188]);
const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function encodeBase58(bytes: Uint8Array): string {
  let leading = 0;
  while (leading < bytes.length && bytes[leading] === 0) leading++;
  let num = 0n;
  for (const byte of bytes) num = num * 256n + BigInt(byte);
  let encoded = '';
  while (num > 0n) {
    const remainder = Number(num % 58n);
    num = num / 58n;
    encoded = BASE58_ALPHABET[remainder] + encoded;
  }
  return '1'.repeat(leading) + encoded;
}

function readInt64(data: Uint8Array, offset: number): bigint {
  let value = 0n;
  for (let i = 7; i >= 0; i--) value = (value << 8n) | BigInt(data[offset + i]);
  return BigInt.asIntN(64, value);
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export interface RpcPlayerProfileAccount {
  owner: string;
  data: Uint8Array;
}

export interface LocatedPlayerProfileAccount extends RpcPlayerProfileAccount {
  address: string;
}

export interface PlayerProfileDependencies {
  fetchAccount?: (address: string, rpcUrl: string) => Promise<RpcPlayerProfileAccount | null>;
  findProfileAccounts?: (program: string, rpcUrl: string) => Promise<LocatedPlayerProfileAccount[]>;
  nowMs?: () => number;
  cacheTtlMs?: number;
}

/**
 * Decodes a Player Profile `Profile` account into the wallet addresses of every
 * non-expired key. Layout (borsh, little-endian): 8-byte discriminator, then
 * version u8, auth_key_count u16, key_threshold u8, next_seq_id u64,
 * created_at i64, then u16 key count, then count × 80-byte ProfileKey entries
 * (key Pubkey, scope Pubkey, expire_time i64, permissions u64).
 */
export function decodePlayerProfileKeys(data: Uint8Array, nowMs = Date.now()): string[] {
  if (data.length < 30) throw new Error('Player Profile account is too short');
  if (!equalBytes(data.subarray(0, 8), PLAYER_PROFILE_DISCRIMINATOR)) {
    throw new Error('Player Profile account has an invalid discriminator');
  }
  const count = data[28] | (data[29] << 8);
  const nowSeconds = BigInt(Math.floor(nowMs / 1000));
  const wallets: string[] = [];
  for (let index = 0; index < count; index++) {
    const offset = 30 + index * 80;
    if (offset + 80 > data.length) break;
    const expireTime = readInt64(data, offset + 64);
    if (expireTime >= 0n && expireTime < nowSeconds) continue; // expired key
    wallets.push(encodeBase58(data.subarray(offset, offset + 32)));
  }
  return wallets;
}

interface AccountJson {
  owner?: string;
  data?: [string, 'base64'] | null;
}

function decodeRpcAccount(account: unknown): RpcPlayerProfileAccount {
  const value = account as AccountJson;
  if (typeof value?.owner !== 'string' || !Array.isArray(value.data) || value.data[1] !== 'base64') {
    throw new Error('Player Profile RPC returned an invalid account');
  }
  return { owner: value.owner, data: Buffer.from(value.data[0], 'base64') };
}

async function rpcRequest(rpcUrl: string, method: string, params: unknown[]): Promise<any> {
  const response = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  if (!response.ok) throw new Error(`Player Profile RPC request failed (${response.status})`);
  const payload = await response.json() as { error?: { message?: string }; result?: unknown };
  if (payload.error) throw new Error(`Player Profile RPC error: ${payload.error.message || 'unknown error'}`);
  return payload.result;
}

async function fetchAccount(address: string, rpcUrl: string): Promise<RpcPlayerProfileAccount | null> {
  const result = await rpcRequest(rpcUrl, 'getAccountInfo', [address, { encoding: 'base64', commitment: 'confirmed' }]);
  return result?.value ? decodeRpcAccount(result.value) : null;
}

async function findProfileAccounts(program: string, rpcUrl: string): Promise<LocatedPlayerProfileAccount[]> {
  const discriminator = Buffer.from(PLAYER_PROFILE_DISCRIMINATOR).toString('base64');
  const result = await rpcRequest(rpcUrl, 'getProgramAccounts', [program, {
    encoding: 'base64', commitment: 'confirmed', filters: [{ memcmp: { offset: 0, bytes: discriminator } }],
  }]);
  if (!Array.isArray(result)) throw new Error('Player Profile RPC returned an invalid account list');
  return result.map((entry) => ({ address: String(entry.pubkey), ...decodeRpcAccount(entry.account) }));
}

function defaultDependencies(): PlayerProfileDependencies {
  return { fetchAccount, findProfileAccounts };
}

const cacheByKey = new Map<string, { atMs: number; owned: string[] }>();

/**
 * Owned wallet addresses: the configured signer wallet plus every wallet key on
 * the configured on-chain Player Profile. The LCFS self-defender guard treats
 * any of these as "me" when one appears as the reservation defender, so it will
 * never overbid a bid placed from any wallet that belongs to the profile.
 *
 * Resolution is attempted against the configured player profile address and
 * falls back to scanning the Player Profile program for the profile that lists
 * the signer wallet. On any RPC/decoding failure the signer wallet alone is
 * returned so the guard degrades gracefully instead of throwing.
 */
export async function resolveOwnedWalletAddresses(
  settings: AppSettings,
  rpcUrl: string,
  dependencies: PlayerProfileDependencies = defaultDependencies(),
): Promise<string[]> {
  const signer = settings.walletAddress.trim();
  const owned = signer ? [signer] : [];
  const profile = settings.playerProfile.trim();
  if (!profile || !rpcUrl.trim()) return owned;

  const nowMs = dependencies.nowMs ? dependencies.nowMs() : Date.now();
  const ttlMs = dependencies.cacheTtlMs ?? 60_000;
  const cacheKey = `${profile}|${rpcUrl}`;
  const cached = cacheByKey.get(cacheKey);
  if (cached && nowMs - cached.atMs < ttlMs) return unique([...cached.owned, ...owned]);

  let profileKeys: string[] = [];
  try {
    const account = await (dependencies.fetchAccount ?? defaultDependencies().fetchAccount!)(profile, rpcUrl);
    if (account && account.owner === PLAYER_PROFILE_PROGRAM_ID) {
      profileKeys = decodePlayerProfileKeys(account.data, nowMs);
    } else {
      const accounts = await (dependencies.findProfileAccounts ?? defaultDependencies().findProfileAccounts!)(PLAYER_PROFILE_PROGRAM_ID, rpcUrl);
      for (const candidate of accounts) {
        if (candidate.owner !== PLAYER_PROFILE_PROGRAM_ID) continue;
        const keys = decodePlayerProfileKeys(candidate.data, nowMs);
        if (signer && keys.includes(signer)) { profileKeys = keys; break; }
      }
    }
  } catch {
    // Fall back to the signer wallet alone; never throw from the guard path.
  }

  const resolved = unique([...owned, ...profileKeys]);
  cacheByKey.set(cacheKey, { atMs: nowMs, owned: resolved });
  return resolved;
}

function unique(addresses: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const address of addresses) {
    if (address && !seen.has(address)) {
      seen.add(address);
      result.push(address);
    }
  }
  return result;
}

export function validatePlayerProfileAddress(value: string): string {
  return value.trim() === '' ? '' : requireSolanaAddress(value, 'playerProfile');
}