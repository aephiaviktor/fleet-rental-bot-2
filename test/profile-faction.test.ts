import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeProfileFactionAccount, resolvePlayerFaction } from '../src/profile-faction.js';

const profile = '11111111111111111111111111111111';
const profileFaction = 'E3Lh2ScF9c9ZZjoTAeNNApFZiQV1Q6GBmvgsKLh8xkL3';
const program = 'pFACSRuobDmvfMKq1bAzwj27t6d2GJhSCHb1VcfnRmq';
const discriminator = [14, 149, 119, 243, 145, 240, 79, 227];

function accountData(faction: number, embeddedProfile = new Uint8Array(32)): Uint8Array {
  return Uint8Array.from([...discriminator, 1, ...embeddedProfile, faction, 255]);
}

test('decodes authoritative ProfileFaction enum values', () => {
  assert.equal(decodeProfileFactionAccount(accountData(0), profile).faction, 'UNALIGNED');
  assert.equal(decodeProfileFactionAccount(accountData(1), profile).faction, 'MUD');
  assert.equal(decodeProfileFactionAccount(accountData(2), profile).faction, 'ONI');
  assert.equal(decodeProfileFactionAccount(accountData(3), profile).faction, 'USTUR');
});

test('rejects invalid ProfileFaction account identity and faction values', () => {
  const wrongProfile = new Uint8Array(32); wrongProfile[31] = 1;
  assert.throws(() => decodeProfileFactionAccount(accountData(1, wrongProfile), profile), /does not match/);
  assert.throws(() => decodeProfileFactionAccount(accountData(4), profile), /Unknown profile faction/);
  assert.throws(() => decodeProfileFactionAccount(Uint8Array.from([0, ...accountData(1).slice(1)]), profile), /discriminator/);
});

test('derives the profile faction PDA, validates its owner, and resolves the faction', async () => {
  let fetchedAddress = '';
  const result = await resolvePlayerFaction(profile, 'https://rpc.example', {
    deriveProfileFaction: async () => profileFaction,
    profileFactionProgram: program,
    fetchAccount: async (address) => {
      fetchedAddress = address;
      return { owner: program, data: accountData(2) };
    },
    findProfileFactionAccounts: async () => [],
  });
  assert.equal(fetchedAddress, profileFaction);
  assert.deepEqual(result, { faction: 'ONI', profileFactionAddress: profileFaction });
});

test('fails closed for missing or wrongly-owned ProfileFaction accounts', async () => {
  const dependencies = {
    deriveProfileFaction: async () => profileFaction,
    profileFactionProgram: program,
    fetchAccount: async () => null,
    findProfileFactionAccounts: async () => [],
  };
  await assert.rejects(() => resolvePlayerFaction(profile, 'https://rpc.example', dependencies), /not registered/);
  await assert.rejects(() => resolvePlayerFaction(profile, 'https://rpc.example', {
    ...dependencies,
    fetchAccount: async () => ({ owner: profile, data: accountData(1) }),
  }), /unexpected program/);
});

test('falls back to the canonical program record when the SDK-derived PDA is absent', async () => {
  const canonicalAddress = '11111111111111111111111111111111';
  const result = await resolvePlayerFaction(profile, 'https://rpc.example', {
    deriveProfileFaction: async () => profileFaction,
    profileFactionProgram: program,
    fetchAccount: async () => null,
    findProfileFactionAccounts: async () => [{ address: canonicalAddress, owner: program, data: accountData(3) }],
  });
  assert.deepEqual(result, { faction: 'USTUR', profileFactionAddress: canonicalAddress });
});

test('rejects ambiguous canonical ProfileFaction records', async () => {
  const dependencies = {
    deriveProfileFaction: async () => profileFaction,
    profileFactionProgram: program,
    fetchAccount: async () => null,
    findProfileFactionAccounts: async () => [
      { address: profile, owner: program, data: accountData(1) },
      { address: profileFaction, owner: program, data: accountData(1) },
    ],
  };
  await assert.rejects(() => resolvePlayerFaction(profile, 'https://rpc.example', dependencies), /multiple faction records/);
});
