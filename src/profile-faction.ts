import { createRequire } from 'node:module';
import { address, getAddressEncoder } from '@solana/kit';
import { requireSolanaAddress } from './solana-address.js';

const require = createRequire(import.meta.url);
const PROFILE_FACTION_DISCRIMINATOR = Uint8Array.from([14, 149, 119, 243, 145, 240, 79, 227]);
const PROFILE_OFFSET = 9;
const FACTION_OFFSET = 41;

export type PlayerFaction = 'UNALIGNED' | 'MUD' | 'ONI' | 'USTUR';

export interface RpcAccount {
  owner: string;
  data: Uint8Array;
}

export interface LocatedRpcAccount extends RpcAccount {
  address: string;
}

export interface ProfileFactionDependencies {
  deriveProfileFaction: (profile: string) => Promise<string>;
  profileFactionProgram: string;
  fetchAccount: (address: string, rpcUrl: string) => Promise<RpcAccount | null>;
  findProfileFactionAccounts: (profile: string, rpcUrl: string) => Promise<LocatedRpcAccount[]>;
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function decodeProfileFactionAccount(data: Uint8Array, expectedProfile: string): { faction: PlayerFaction } {
  if (data.length < 43) throw new Error('Profile faction account is too short');
  if (!equalBytes(data.slice(0, 8), PROFILE_FACTION_DISCRIMINATOR)) {
    throw new Error('Profile faction account has an invalid discriminator');
  }
  const profileBytes = Uint8Array.from(getAddressEncoder().encode(address(requireSolanaAddress(expectedProfile, 'playerProfile'))));
  if (!equalBytes(data.slice(PROFILE_OFFSET, PROFILE_OFFSET + 32), profileBytes)) {
    throw new Error('Profile faction account does not match the configured Player Profile');
  }
  const faction = (['UNALIGNED', 'MUD', 'ONI', 'USTUR'] as const)[data[FACTION_OFFSET]];
  if (!faction) throw new Error(`Unknown profile faction value: ${String(data[FACTION_OFFSET])}`);
  return { faction };
}

async function rpcRequest(rpcUrl: string, method: string, params: unknown[]): Promise<any> {
  const response = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  if (!response.ok) throw new Error(`Player faction RPC request failed (${response.status})`);
  const payload = await response.json() as { error?: { message?: string }; result?: unknown };
  if (payload.error) throw new Error(`Player faction RPC error: ${payload.error.message || 'unknown error'}`);
  return payload.result;
}

function decodeRpcAccount(account: any): RpcAccount {
  if (typeof account?.owner !== 'string' || !Array.isArray(account.data) || account.data[1] !== 'base64') {
    throw new Error('Player faction RPC returned an invalid account');
  }
  return { owner: account.owner, data: Buffer.from(account.data[0], 'base64') };
}

async function fetchRpcAccount(address: string, rpcUrl: string): Promise<RpcAccount | null> {
  const result = await rpcRequest(rpcUrl, 'getAccountInfo', [address, { encoding: 'base64', commitment: 'confirmed' }]);
  return result?.value ? decodeRpcAccount(result.value) : null;
}

async function findRpcProfileFactionAccounts(profile: string, rpcUrl: string, program: string): Promise<LocatedRpcAccount[]> {
  const result = await rpcRequest(rpcUrl, 'getProgramAccounts', [program, {
    encoding: 'base64', commitment: 'confirmed', filters: [{ memcmp: { offset: PROFILE_OFFSET, bytes: profile } }],
  }]);
  if (!Array.isArray(result)) throw new Error('Player faction RPC returned an invalid account list');
  return result.map((entry) => ({ address: String(entry.pubkey), ...decodeRpcAccount(entry.account) }));
}

function defaultDependencies(): ProfileFactionDependencies {
  const core = require('@sly-rentals/core') as typeof import('@sly-rentals/core');
  return {
    deriveProfileFaction: async (profile) => String(await core.deriveProfileFaction(profile)),
    profileFactionProgram: core.MAINNET_ADDRESSES.profileFaction,
    fetchAccount: fetchRpcAccount,
    findProfileFactionAccounts: (profile, rpcUrl) => findRpcProfileFactionAccounts(profile, rpcUrl, core.MAINNET_ADDRESSES.profileFaction),
  };
}

export async function resolvePlayerFaction(
  playerProfile: string,
  rpcUrl: string,
  dependencies = defaultDependencies(),
): Promise<{ faction: PlayerFaction; profileFactionAddress: string }> {
  const profile = requireSolanaAddress(playerProfile, 'playerProfile');
  if (!rpcUrl.trim()) throw new Error('RPC URL is required');
  const profileFactionAddress = await dependencies.deriveProfileFaction(profile);
  const derivedAccount = await dependencies.fetchAccount(profileFactionAddress, rpcUrl);
  if (derivedAccount) {
    if (derivedAccount.owner !== dependencies.profileFactionProgram) {
      throw new Error('Profile faction account belongs to an unexpected program');
    }
    return { ...decodeProfileFactionAccount(derivedAccount.data, profile), profileFactionAddress };
  }
  const canonicalAccounts = await dependencies.findProfileFactionAccounts(profile, rpcUrl);
  if (canonicalAccounts.length === 0) throw new Error('Player Profile is not registered with a faction');
  if (canonicalAccounts.length > 1) throw new Error('Player Profile has multiple faction records');
  const canonical = canonicalAccounts[0];
  if (canonical.owner !== dependencies.profileFactionProgram) {
    throw new Error('Profile faction account belongs to an unexpected program');
  }
  return { ...decodeProfileFactionAccount(canonical.data, profile), profileFactionAddress: canonical.address };
}
