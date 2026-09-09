import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const expectedShortLabels: Record<string, string> = {
  rentalRate: 'Rate/d',
  rentalCost: 'Rent total',
  reservationBid: 'Bid',
  minimumTakeoverBid: 'Next bid',
  reservationPremiumPerDay: 'Bid/d',
  allInCostPerDay: 'All-in/d',
  defenderPrincipalRefund: 'Refund',
  ownerPremiumShareIfOutbidNow: 'Owner share',
  atlasLocked: 'Locked',
  holdingFraction: 'Held %',
  bonusIfOutbidNow: 'Bonus',
  estimatedPointsPerDay: 'Pts/d',
  estimatedPoints: 'Pts total',
  positionStatus: 'Status',
};

test('table uses compact labels for every live column', async () => {
  const renderer = await readFile(new URL('../../ui/app.js', import.meta.url), 'utf8');
  for (const [id, shortLabel] of Object.entries(expectedShortLabels)) {
    assert.match(renderer, new RegExp(`${id}:'${shortLabel.replace('/', '\\/')}'`), id);
  }
});

test('editable net value follows Days while Safe and Note are selectable', async () => {
  const renderer = await readFile(new URL('../../ui/app.js', import.meta.url), 'utf8');
  assert.match(renderer, /short:'Net value\/d'.*field:'estimatedNetValueAtlas'/);
  assert.match(renderer, /id:'canSafelyOperate'.*selectable:true/);
  assert.match(renderer, /id:'comment'.*selectable:true/);
  assert.match(renderer, /requestedDurationSeconds:2073600/);
  assert.doesNotMatch(renderer, /estimatedOperatingValueAtlas/);
  assert.doesNotMatch(renderer, /recommendation:'Action'/);
});

test('table renders compact headers with full header and value tooltips', async () => {
  const [renderer, styles] = await Promise.all([
    readFile(new URL('../../ui/app.js', import.meta.url), 'utf8'),
    readFile(new URL('../../ui/styles.css', import.meta.url), 'utf8'),
  ]);

  assert.match(renderer, /compactLabels/);
  assert.match(renderer, /\.title=/);
  assert.match(renderer, /label.*value/);
  assert.match(styles, /\.rules-table\{width:max-content;min-width:100%/);
});
