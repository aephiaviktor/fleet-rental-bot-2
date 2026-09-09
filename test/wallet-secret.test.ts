import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const {
  decodeWalletSecret,
  encodeBase58,
  getHotWalletAddressFromSecret,
} = require('../../electron/wallet-secret.cjs') as {
  decodeWalletSecret: (value: string) => Uint8Array;
  encodeBase58: (value: Uint8Array) => string;
  getHotWalletAddressFromSecret: (value: string) => string;
};

const secret = Uint8Array.from([
  1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  206, 204, 21, 7, 220, 29, 221, 114, 149, 149, 28, 41, 8, 136, 240, 149,
  173, 185, 4, 77, 27, 115, 214, 150, 230, 223, 6, 93, 104, 59, 212, 252,
]);

test('accepts LM Market Bot wallet-secret formats and derives one address', () => {
  const json = JSON.stringify([...secret]);
  const hex = Buffer.from(secret).toString('hex');
  const base58 = encodeBase58(secret);
  assert.deepEqual(decodeWalletSecret(json), secret);
  assert.deepEqual(decodeWalletSecret(hex), secret);
  assert.deepEqual(decodeWalletSecret(base58), secret);
  const address = getHotWalletAddressFromSecret(json);
  assert.equal(address, getHotWalletAddressFromSecret(hex));
  assert.equal(address, getHotWalletAddressFromSecret(base58));
  assert.match(address, /^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
});

test('rejects malformed and mismatched wallet secrets', () => {
  assert.throws(() => decodeWalletSecret(''), /empty/i);
  assert.throws(() => getHotWalletAddressFromSecret('[1,2,3]'), /64 bytes/i);
  const mismatched = Uint8Array.from(secret);
  mismatched[63] ^= 1;
  assert.throws(() => getHotWalletAddressFromSecret(JSON.stringify([...mismatched])), /public key/i);
});
