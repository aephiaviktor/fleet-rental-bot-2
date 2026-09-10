import assert from 'node:assert/strict';
import test from 'node:test';
import { nextRefreshDelayMs, refreshCadenceMs } from '../src/refresh-schedule.js';

const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

test('uses the requested adaptive cadence at each ending-in threshold', () => {
  assert.equal(refreshCadenceMs(null, 0), 6 * HOUR);
  assert.equal(refreshCadenceMs(2 * DAY, 0), 6 * HOUR);
  assert.equal(refreshCadenceMs(DAY, 0), HOUR);
  assert.equal(refreshCadenceMs(HOUR, 0), 10 * MINUTE);
  assert.equal(refreshCadenceMs(5 * MINUTE, 0), MINUTE);
});

test('wakes at the next threshold instead of sleeping through it', () => {
  const now = Date.UTC(2026, 8, 10, 12);
  assert.equal(nextRefreshDelayMs([now + DAY + 20 * MINUTE], now), 20 * MINUTE);
  assert.equal(nextRefreshDelayMs([now + HOUR + 5 * MINUTE], now), 5 * MINUTE);
  assert.equal(nextRefreshDelayMs([now + 6 * MINUTE], now), MINUTE);
});

test('uses the earliest due fleet without accelerating unrelated fleet calculations', () => {
  const now = Date.UTC(2026, 8, 10, 12);
  assert.equal(nextRefreshDelayMs([now + 4 * DAY, now + 30 * MINUTE], now), 10 * MINUTE);
  assert.equal(nextRefreshDelayMs([], now), 6 * HOUR);
});
