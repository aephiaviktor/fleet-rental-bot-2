import assert from 'node:assert/strict';
import test from 'node:test';
import { address } from '@solana/kit';
import { simulateUnsignedInstructions } from '../src/transaction-simulation.js';

const wallet = 'Erdrp29yxiCVyYJgJtZz2ZYAbxiDV5UUDLNEZJsxSL7';
const instructions = [{
  programAddress: address('ComputeBudget111111111111111111111111111111'),
  accounts: [],
  data: new Uint8Array([2, 224, 147, 4, 0]),
}];

test('compiles a zero-signature payload and simulates with signature verification disabled', async () => {
  let capturedWire = '';
  let capturedConfig: unknown = null;
  const result = await simulateUnsignedInstructions({
    instructions,
    walletAddress: wallet,
    getLatestBlockhash: async () => ({ blockhash: '11111111111111111111111111111111', lastValidBlockHeight: 247526n }),
    simulateWire: async (wire, config) => {
      capturedWire = wire;
      capturedConfig = config;
      return { err: null, logs: ['Program log: ok'], unitsConsumed: 123_456 };
    },
  });
  assert.ok(capturedWire.length > 100);
  assert.deepEqual(capturedConfig, { encoding: 'base64', sigVerify: false, commitment: 'confirmed' });
  assert.deepEqual(result, { ok: true, error: null, logs: ['Program log: ok'], unitsConsumed: 123_456, lastValidBlockHeight: 247526n });
});

test('returns program simulation failures without treating them as success', async () => {
  const result = await simulateUnsignedInstructions({
    instructions,
    walletAddress: wallet,
    getLatestBlockhash: async () => ({ blockhash: '11111111111111111111111111111111', lastValidBlockHeight: 10n }),
    simulateWire: async () => ({ err: { InstructionError: [1, 'Custom'] }, logs: ['Program failed'], unitsConsumed: 42 }),
  });
  assert.equal(result.ok, false);
  assert.match(result.error!, /InstructionError/);
  assert.equal(result.unitsConsumed, 42);
});
