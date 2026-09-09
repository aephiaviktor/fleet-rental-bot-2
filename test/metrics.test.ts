import assert from 'node:assert/strict';
import test from 'node:test';
import { estimateDefenderBonusAtlas, estimatePoints, estimateRentalCostAtlas, holdingFraction } from '../src/metrics.js';

test('prorates rental cost to the requested duration', () => {
  assert.equal(estimateRentalCostAtlas(240, 12 * 60 * 60), 120);
});

test('computes holding fraction over the time available since reservation', () => {
  assert.equal(holdingFraction(1_000, 11_000, 6_000), 0.5);
});

test('caps defender bonus at the challenger bid difference', () => {
  assert.equal(estimateDefenderBonusAtlas(100, 110, 0.5), 5);
  assert.equal(estimateDefenderBonusAtlas(100, 110, 1, 2), 10);
});

test('estimates weighted points for partial days', () => {
  assert.equal(estimatePoints(10, 3, 12 * 60 * 60), 15);
});
