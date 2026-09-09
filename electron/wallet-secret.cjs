'use strict';

const { createPrivateKey, createPublicKey, timingSafeEqual } = require('node:crypto');

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const BASE58_INDEX = new Map([...BASE58_ALPHABET].map((character, index) => [character, index]));
const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

function encodeBase58(value) {
  const bytes = Uint8Array.from(value);
  let number = 0n;
  for (const byte of bytes) number = number * 256n + BigInt(byte);
  let encoded = '';
  while (number > 0n) {
    const remainder = Number(number % 58n);
    encoded = BASE58_ALPHABET[remainder] + encoded;
    number /= 58n;
  }
  let leadingZeroes = 0;
  while (leadingZeroes < bytes.length && bytes[leadingZeroes] === 0) leadingZeroes += 1;
  return '1'.repeat(leadingZeroes) + encoded;
}

function decodeBase58(value) {
  let number = 0n;
  for (const character of value) {
    const digit = BASE58_INDEX.get(character);
    if (digit === undefined) throw new Error('Hot wallet secret is not valid base58.');
    number = number * 58n + BigInt(digit);
  }
  const decoded = [];
  while (number > 0n) {
    decoded.push(Number(number % 256n));
    number /= 256n;
  }
  decoded.reverse();
  let leadingZeroes = 0;
  while (leadingZeroes < value.length && value[leadingZeroes] === '1') leadingZeroes += 1;
  return Uint8Array.from([...new Array(leadingZeroes).fill(0), ...decoded]);
}

function decodeWalletSecret(secret) {
  const trimmed = String(secret || '').trim();
  if (!trimmed) throw new Error('Hot wallet secret is empty.');
  if (trimmed.startsWith('[')) {
    const parsed = JSON.parse(trimmed);
    if (!Array.isArray(parsed) || parsed.some((byte) => !Number.isInteger(byte) || byte < 0 || byte > 255)) {
      throw new Error('Hot wallet secret JSON value must be an array of bytes.');
    }
    return Uint8Array.from(parsed);
  }
  const hexValue = trimmed.startsWith('0x') ? trimmed.slice(2) : trimmed;
  if (/^[0-9a-fA-F]+$/.test(hexValue)) {
    if (hexValue.length % 2 !== 0) throw new Error('Hot wallet secret hex value must have an even length.');
    return Uint8Array.from(Buffer.from(hexValue, 'hex'));
  }
  return decodeBase58(trimmed);
}

function derivePublicKey(seed) {
  const privateKey = createPrivateKey({
    key: Buffer.concat([ED25519_PKCS8_PREFIX, Buffer.from(seed)]),
    format: 'der',
    type: 'pkcs8',
  });
  const subjectPublicKeyInfo = createPublicKey(privateKey).export({ format: 'der', type: 'spki' });
  return Buffer.from(subjectPublicKeyInfo).subarray(-32);
}

function getHotWalletAddressFromSecret(secret) {
  const decoded = decodeWalletSecret(secret);
  try {
    if (decoded.length !== 64) throw new Error('Hot wallet secret must contain exactly 64 bytes.');
    const derivedPublicKey = derivePublicKey(decoded.subarray(0, 32));
    if (!timingSafeEqual(derivedPublicKey, Buffer.from(decoded.subarray(32)))) {
      throw new Error('Hot wallet secret public key does not match its private seed.');
    }
    return encodeBase58(derivedPublicKey);
  } finally {
    decoded.fill(0);
  }
}

module.exports = { decodeWalletSecret, encodeBase58, getHotWalletAddressFromSecret };
