import assert from 'node:assert/strict';
import test from 'node:test';
import { formatRemainingRentalTime } from '../src/remaining-time.js';

test('formats remaining rental time as whole days and hours', () => {
  assert.equal(formatRemainingRentalTime(100_000, 100_000), '0d 0h');
  assert.equal(formatRemainingRentalTime(100_000 + 26 * 3_600_000 + 59 * 60_000, 100_000), '1d 2h');
  assert.equal(formatRemainingRentalTime(100_000 - 1, 100_000), '0d 0h');
});

test('shows unavailable when there is no active rental ending time', () => {
  assert.equal(formatRemainingRentalTime(null, 100_000), '—');
});
