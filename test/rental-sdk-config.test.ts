import assert from 'node:assert/strict';
import test from 'node:test';
import { MAINNET_SAGE_PROGRAM, rentalSdk } from '../src/rental-sdk.js';

test('configures every rental SDK use for mainnet SAGE', () => {
  const sdk = rentalSdk();
  assert.equal(sdk.getSdkConfig().programs, 'mainnet');
  assert.equal(sdk.getAddresses().sage, MAINNET_SAGE_PROGRAM);
  assert.equal(MAINNET_SAGE_PROGRAM, 'SAGE2HAwep459SNq61LHvjxPk4pLPEJLoMETef7f7EE');
});
