import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PLAYER_PROFILE_PROGRAM_ID,
  decodePlayerProfileKeys,
  resolveOwnedWalletAddresses,
  resolveWalletOwnership,
} from '../src/player-profile.js';
import { DEFAULT_SETTINGS } from '../src/settings-store.js';

const signer = 'E3Lh2ScF9c9ZZjoTAeNNApFZiQV1Q6GBmvgsKLh8xkL3';
const mainWallet = '4wBqpZM9xaSheZzJSMawUKKwhdpChKbZ5eu5ky4Vigw';
const lancerWallet = 'JEJUoGfGEPTZ1XTwN39dYdFxYxDiDaSKVNy5qYWJmZt3';

const DISCRIMINATOR = [184, 101, 165, 188, 95, 63, 127, 188];

// Base58 encoder mirroring the wallet-secret algorithm, used to build expected outputs.
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function encodeBase58(bytes: Uint8Array): string {
  let leading = 0;
  while (leading < bytes.length && bytes[leading] === 0) leading++;
  let num = 0n;
  for (const b of Array.from(bytes)) num = num * 256n + BigInt(b);
  let out = '';
  while (num > 0n) {
    const rem = Number(num % 58n);
    num /= 58n;
    out = B58[rem] + out;
  }
  return '1'.repeat(leading) + out;
}

function keyBytes(addr: string): Uint8Array {
  // Encode a known pubkey: bytes 1..32 encodes to mainWallet, 255..254-1.. to lancerWallet.
  if (addr === mainWallet) return Uint8Array.from(Array.from({ length: 32 }, (_v, i) => i + 1));
  if (addr === lancerWallet) return Uint8Array.from(Array.from({ length: 32 }, (_v, i) => 255 - i));
  // Generic: not used in fixtures below.
  return Uint8Array.from(Array.from({ length: 32 }, (_v, i) => (addr.charCodeAt(i % addr.length) + i) % 256));
}

function profileAccountData(keyAddresses: string[]): Uint8Array {
  const body = new Uint8Array(30 + keyAddresses.length * 80);
  body.set(DISCRIMINATOR, 0);
  // version=1 at 8, auth_key_count u16 at 9, key_threshold u8 at 11, next_seq_id u64 at 12, created_at i64 at 20
  body[8] = 1;
  body[9] = keyAddresses.length & 0xff;
  body[10] = (keyAddresses.length >> 8) & 0xff;
  body[11] = 1;
  body[12] = 0; // next_seq_id
  // created_at i64 at 20..28 stays 0
  // count u16 at 28..30
  body[28] = keyAddresses.length & 0xff;
  body[29] = (keyAddresses.length >> 8) & 0xff;
  keyAddresses.forEach((addr, i) => {
    const off = 30 + i * 80;
    body.set(keyBytes(addr), off); // key pubkey
    // scope (32) zeros, expire_time i64 (8) = -1 (never), permissions u64 = 0
    for (let b = off + 64; b < off + 72; b++) body[b] = 0xff;
  });
  return body;
}

test('decodes Player Profile account keys into wallet addresses', () => {
  const result = decodePlayerProfileKeys(profileAccountData([mainWallet, lancerWallet]));
  assert.deepEqual(result, [mainWallet, lancerWallet]);
  assert.equal(encodeBase58(keyBytes(mainWallet)), mainWallet);
  assert.equal(encodeBase58(keyBytes(lancerWallet)), lancerWallet);
});

test('throws on buffers that are not Player Profile accounts', () => {
  assert.throws(() => decodePlayerProfileKeys(new Uint8Array([1, 2, 3])), /Player Profile/);
  const wrongDiscriminator = new Uint8Array(40);
  wrongDiscriminator.set([9, 9, 9, 9, 9, 9, 9, 9], 0);
  assert.throws(() => decodePlayerProfileKeys(wrongDiscriminator), /Player Profile/);
});

test('resolves owned wallets as signer plus all profile keys', async () => {
  const profile = mainWallet;
  const settings = { ...DEFAULT_SETTINGS, playerProfile: profile, walletAddress: signer };
  let fetchCalls = 0;
  const deps = {
    nowMs: () => 1_000,
    cacheTtlMs: 0,
    fetchAccount: async () => { fetchCalls += 1; return { owner: PLAYER_PROFILE_PROGRAM_ID, data: profileAccountData([mainWallet, lancerWallet]) }; },
    findProfileAccounts: async () => [],
  };
  const owned = await resolveOwnedWalletAddresses(settings, 'https://rpc.example', deps as never);
  assert.equal(fetchCalls, 1);
  assert.ok(owned.includes(signer));
  assert.ok(owned.includes(lancerWallet));
  assert.equal(owned.length, new Set(owned).size);
});

test('reports unknown ownership but preserves acquisition-first signer fallback when the profile is unavailable', async () => {
  const settings = { ...DEFAULT_SETTINGS, playerProfile: mainWallet, walletAddress: signer };
  const deps = { nowMs: () => 1_000, cacheTtlMs: 0, fetchAccount: async () => null, findProfileAccounts: async () => [] };
  const ownership = await resolveWalletOwnership(settings, 'https://rpc.example', deps as never);
  assert.deepEqual(ownership, { status: 'unknown', addresses: [signer] });
  assert.deepEqual(await resolveOwnedWalletAddresses(settings, 'https://rpc.example', deps as never), [signer]);
});

test('reports resolved ownership when the configured profile account decodes successfully', async () => {
  const settings = { ...DEFAULT_SETTINGS, playerProfile: mainWallet, walletAddress: signer };
  const deps = {
    nowMs: () => 1_000,
    cacheTtlMs: 0,
    fetchAccount: async () => ({ owner: PLAYER_PROFILE_PROGRAM_ID, data: profileAccountData([mainWallet, lancerWallet]) }),
    findProfileAccounts: async () => [],
  };
  const ownership = await resolveWalletOwnership(settings, 'https://rpc.example', deps as never);
  assert.equal(ownership.status, 'resolved');
  assert.deepEqual(ownership.addresses, [signer, mainWallet, lancerWallet]);
});

test('returns only the signer wallet when no player profile is configured', async () => {
  const settings = { ...DEFAULT_SETTINGS, playerProfile: '', walletAddress: signer };
  const owned = await resolveOwnedWalletAddresses(settings, 'https://rpc.example', {} as never);
  assert.deepEqual(owned, [signer]);
});
test('history wallet roles distinguish profile AUTH scope from unrelated permission bits',async()=>{
 const {historyWalletRoles}=await import('../src/player-profile.js');
 const {getAddressEncoder,address}=await import('@solana/kit');
 const data=profileAccountData([mainWallet,lancerWallet]);data[30+72]=1;
 assert.equal(historyWalletRoles(data).main,null);
 data.set(getAddressEncoder().encode(address(PLAYER_PROFILE_PROGRAM_ID)),30+32);
 assert.equal(historyWalletRoles(data).main,mainWallet);
 data[110+72]=1;data.set(getAddressEncoder().encode(address(PLAYER_PROFILE_PROGRAM_ID)),110+32);
 assert.equal(historyWalletRoles(data).main,null);
 assert.throws(()=>historyWalletRoles(data.subarray(0,100)),/Truncated/);
});
