const state = { document: null, columns: [], settings: null, live: new Map(), refreshTimer: null };
const byId = (id) => document.getElementById(id);

function make(tag, text, className) {
  const element = document.createElement(tag);
  if (text != null) element.textContent = text;
  if (className) element.className = className;
  return element;
}

const number = (value, digits = 2) => value == null ? '—' : Number(value).toLocaleString(undefined, { maximumFractionDigits: digits });
const duration = (milliseconds) => {
  if (milliseconds == null) return '—';
  const hours = milliseconds / 3_600_000;
  return hours >= 48 ? `${number(hours / 24, 1)} d` : `${number(hours, 1)} h`;
};

function displayValue(entry, columnId) {
  const result = state.live.get(entry.id);
  if (result && !result.ok) return columnId === 'recommendation' ? 'Refresh error' : '—';
  const row = result?.row;
  const snapshot = row?.snapshot;
  const position = row?.position;
  const days = entry.requestedDurationSeconds / 86400;
  const values = {
    label: entry.label,
    requestedDuration: `${days.toLocaleString(undefined, { maximumFractionDigits: 2 })} d`,
    rentalRate: snapshot ? `${number(snapshot.rentalRateAtlasPerDay)} ATLAS/d` : '—',
    rentalCost: row ? `${number(row.rentalCostAtlas)} ATLAS` : '—',
    operatingValue: entry.estimatedOperatingValueAtlas == null ? '—' : `${number(entry.estimatedOperatingValueAtlas)} ATLAS`,
    netValue: row?.netOperatingValueAtlas == null ? '—' : `${number(row.netOperatingValueAtlas)} ATLAS`,
    maximumRentalRate: `${number(entry.maximumRentalRateAtlasPerDay)} ATLAS/d`,
    maximumReservationBid: `${number(entry.maximumReservationBidAtlas)} ATLAS`,
    reservationCurrency: snapshot?.reservationCurrency ?? '—',
    reservationBid: snapshot?.reservationCurrency === 'POINTS' ? `${number(snapshot.reservationBidPoints)} Points` : snapshot?.reservationBidAtlas == null ? '—' : `${number(snapshot.reservationBidAtlas)} ATLAS`,
    minimumTakeoverBid: snapshot?.reservationCurrency === 'POINTS' ? `${number(snapshot.minimumTakeoverBidPoints)} Points` : snapshot ? `${number(snapshot.minimumTakeoverBidAtlas)} ATLAS` : '—',
    atlasLocked: position ? `${number(position.atlasLocked)} ATLAS` : '—',
    reservationAge: row ? duration(row.reservationAgeMs) : '—',
    holdingFraction: row?.holdingFraction == null ? '—' : `${number(row.holdingFraction * 100, 1)}%`,
    bonusIfOutbidNow: row?.bonusIfOutbidNowAtlas == null ? '—' : `${number(row.bonusIfOutbidNowAtlas)} ATLAS`,
    projectedExpiryFloorBonus: row?.projectedExpiryFloorBonusAtlas == null ? '—' : `${number(row.projectedExpiryFloorBonusAtlas)} ATLAS`,
    maximumRemainingLock: row ? duration(row.maximumRemainingLockMs) : '—',
    fleetWeight: snapshot ? number(snapshot.fleetWeight, 0) : '—',
    estimatedPointsPerDay: snapshot ? number(snapshot.effectivePointsPerDay) : '—',
    estimatedPoints: row ? number(row.estimatedPoints) : '—',
    pointsPerThousandAtlas: row ? number(row.pointsPerThousandAtlas) : '—',
    existingPointsBalance: '—',
    recommendation: !entry.enabled ? 'Disabled' : row ? row.recommendation : 'Waiting for live data',
    positionStatus: !entry.enabled ? 'Disabled' : position?.status ?? '—',
  };
  return values[columnId] ?? '—';
}

function renderTable() {
  const visible = state.document.visibleColumns;
  const definitions = visible.map((id) => state.columns.find((column) => column.id === id)).filter(Boolean);
  const head = byId('table-head');
  const body = byId('table-body');
  head.replaceChildren(...definitions.map((column) => make('th', column.label)));
  head.append(make('th', ''));
  body.replaceChildren();
  for (const entry of state.document.entries) {
    const row = make('tr');
    if (!entry.enabled) row.classList.add('disabled-row');
    for (const column of definitions) row.append(make('td', displayValue(entry, column.id)));
    const actions = make('td');
    const edit = make('button', 'Edit', 'table-action');
    edit.type = 'button';
    edit.addEventListener('click', () => openDialog(entry));
    const review = make('button', 'Review', 'table-action');
    review.type = 'button';
    review.disabled = !entry.enabled;
    review.addEventListener('click', () => openReview(entry));
    actions.append(review, edit);
    row.append(actions);
    const result = state.live.get(entry.id);
    if (result && !result.ok) { row.classList.add('error-row'); row.title = result.error; }
    body.append(row);
  }
  byId('empty-state').hidden = state.document.entries.length !== 0;
}

async function openReview(entry) {
  byId('review-dialog').dataset.entryId = entry.id;
  byId('review-title').textContent = entry.label;
  byId('review-loading').hidden = false;
  byId('review-content').hidden = true;
  byId('review-blocked').hidden = true;
  byId('simulation-result').hidden = true;
  byId('simulate-button').disabled = true;
  byId('review-dialog').showModal();
  try {
    const review = await window.fleetRentalBot.prepareReservationReview(entry.id);
    byId('review-loading').hidden = true;
    if (review.kind === 'blocked') {
      byId('review-blocked').textContent = `${review.plan.reason}: ${review.plan.detail}`;
      byId('review-blocked').hidden = false;
      return;
    }
    byId('review-action').textContent = review.plan.action.toUpperCase();
    byId('review-bid').textContent = `${number(review.plan.bidAtlas)} ATLAS`;
    byId('review-duration').textContent = `${number(review.plan.requestedDurationSeconds / 86400, 2)} days`;
    byId('review-count').textContent = String(review.instructionCount);
    byId('review-warning').textContent = `Maximum bid remains ${number(review.plan.maximumBidAtlas)} ATLAS. This payload cannot sign or submit.`;
    const list = byId('review-instructions');
    list.replaceChildren();
    for (const instruction of review.instructions) {
      const card = make('div', null, 'instruction');
      card.append(make('strong', `#${instruction.index + 1} · ${instruction.programAddress}`));
      card.append(make('span', `${instruction.dataBytes} data bytes · ${instruction.accounts.length} accounts`));
      const accounts = make('details');
      accounts.append(make('summary', 'Derived accounts'));
      for (const account of instruction.accounts) accounts.append(make('code', `${account.address} · role ${account.role}`));
      card.append(accounts);
      list.append(card);
    }
    byId('review-content').hidden = false;
    byId('simulate-button').disabled = false;
  } catch (error) {
    byId('review-loading').hidden = true;
    byId('review-blocked').textContent = error instanceof Error ? error.message : String(error);
    byId('review-blocked').hidden = false;
  }
}

async function simulateReviewedReservation() {
  const entryId = byId('review-dialog').dataset.entryId;
  const button = byId('simulate-button');
  button.disabled = true;
  button.textContent = 'Simulating…';
  byId('simulation-result').hidden = true;
  try {
    const result = await window.fleetRentalBot.simulateReservation(entryId);
    if (result.kind === 'blocked') {
      byId('simulation-status').textContent = 'SIMULATION BLOCKED';
      byId('simulation-units').textContent = result.plan.reason;
      byId('simulation-logs').textContent = result.plan.detail;
    } else {
      byId('simulation-status').textContent = result.simulation.ok ? 'SIMULATION PASSED' : 'SIMULATION FAILED';
      byId('simulation-status').className = result.simulation.ok ? 'simulation-pass' : 'error';
      byId('simulation-units').textContent = `${number(result.simulation.unitsConsumed, 0)} compute units · valid through block ${result.simulation.lastValidBlockHeight}`;
      const lines = result.simulation.logs.length ? result.simulation.logs : ['No program logs returned'];
      if (result.simulation.error) lines.unshift(`ERROR: ${result.simulation.error}`);
      byId('simulation-logs').textContent = lines.join('\n');
    }
    byId('simulation-result').hidden = false;
  } catch (error) {
    byId('simulation-status').textContent = 'SIMULATION ERROR';
    byId('simulation-status').className = 'error';
    byId('simulation-units').textContent = '';
    byId('simulation-logs').textContent = error instanceof Error ? error.message : String(error);
    byId('simulation-result').hidden = false;
  } finally {
    button.disabled = false;
    button.textContent = 'Simulate';
  }
}

function renderSummary() {
  const successful = [...state.live.values()].filter((result) => result.ok).map((result) => result.row);
  byId('summary-locked').textContent = `${number(successful.reduce((sum, row) => sum + row.position.atlasLocked, 0))} ATLAS`;
  byId('summary-defenses').textContent = String(successful.filter((row) => row.position.status === 'defending').length);
  byId('summary-enabled').textContent = String(state.document.entries.filter((entry) => entry.enabled).length);
}

function scheduleRefresh() {
  clearInterval(state.refreshTimer);
  state.refreshTimer = setInterval(refresh, state.settings.refreshIntervalSeconds * 1000);
}

async function refresh() {
  const button = byId('refresh-button');
  button.disabled = true;
  button.textContent = 'Refreshing…';
  try {
    const results = await window.fleetRentalBot.refreshWatchlist();
    state.live = new Map(results.map((result) => [result.id, result]));
    byId('summary-refreshed').textContent = new Date().toLocaleTimeString();
    renderTable();
    renderSummary();
  } finally {
    button.disabled = false;
    button.textContent = 'Refresh';
  }
}

function renderColumnOptions() {
  const container = byId('column-options');
  container.replaceChildren();
  for (const column of state.columns) {
    const label = make('label');
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = state.document.visibleColumns.includes(column.id);
    input.addEventListener('change', async () => {
      const selected = new Set(state.document.visibleColumns);
      input.checked ? selected.add(column.id) : selected.delete(column.id);
      if (selected.size === 0) { input.checked = true; return; }
      state.document.visibleColumns = state.columns.map((item) => item.id).filter((id) => selected.has(id));
      renderTable();
      await save();
    });
    label.append(input, document.createTextNode(column.label));
    container.append(label);
  }
}

async function save() {
  byId('save-state').textContent = 'Saving…';
  try {
    await window.fleetRentalBot.saveWatchlist(state.document);
    byId('save-state').textContent = 'Saved';
  } catch (error) {
    byId('save-state').textContent = 'Save failed';
    throw error;
  }
}

function openDialog(entry = null) {
  byId('dialog-title').textContent = entry ? 'Edit fleet' : 'Add fleet';
  byId('entry-id').value = entry?.id ?? '';
  byId('entry-label').value = entry?.label ?? '';
  byId('entry-contract').value = entry?.contractAddress ?? '';
  byId('entry-duration').value = entry ? String(entry.requestedDurationSeconds / 86400) : '7';
  byId('entry-value').value = entry?.estimatedOperatingValueAtlas ?? '';
  byId('entry-max-rate').value = entry?.maximumRentalRateAtlasPerDay ?? '';
  byId('entry-max-bid').value = entry?.maximumReservationBidAtlas ?? '';
  byId('entry-comment').value = entry?.comment ?? '';
  byId('entry-enabled').checked = entry?.enabled ?? true;
  byId('entry-operable').checked = entry?.canSafelyOperate ?? true;
  byId('entry-delete').hidden = !entry;
  byId('form-error').hidden = true;
  byId('fleet-dialog').showModal();
}

function formEntry() {
  const operatingValue = byId('entry-value').value.trim();
  return {
    id: byId('entry-id').value || crypto.randomUUID(),
    label: byId('entry-label').value.trim(),
    contractAddress: byId('entry-contract').value.trim(),
    requestedDurationSeconds: Number(byId('entry-duration').value) * 86400,
    estimatedOperatingValueAtlas: operatingValue === '' ? null : Number(operatingValue),
    maximumRentalRateAtlasPerDay: Number(byId('entry-max-rate').value),
    maximumReservationBidAtlas: Number(byId('entry-max-bid').value),
    canSafelyOperate: byId('entry-operable').checked,
    enabled: byId('entry-enabled').checked,
    comment: byId('entry-comment').value.trim(),
  };
}

async function bootstrap() {
  const [details, watchlist, settings] = await Promise.all([
    window.fleetRentalBot.getBootstrap(), window.fleetRentalBot.loadWatchlist(), window.fleetRentalBot.loadSettings(),
  ]);
  state.document = watchlist.document;
  state.columns = watchlist.columns;
  state.settings = settings;
  byId('version').textContent = `v${details.version}`;
  byId('data-directory').textContent = details.dataDirectory;
  byId('mode').textContent = details.readOnly ? 'READ-ONLY' : 'LIVE';
  byId('mode').classList.add(details.readOnly ? 'safe' : 'live');
  renderColumnOptions();
  renderTable();
  renderSummary();
  scheduleRefresh();
  if (state.document.entries.some((entry) => entry.enabled)) await refresh();
}

byId('add-button').addEventListener('click', () => openDialog());
byId('columns-button').addEventListener('click', () => { byId('columns-panel').hidden = !byId('columns-panel').hidden; });
byId('columns-done').addEventListener('click', () => { byId('columns-panel').hidden = true; });
byId('refresh-button').addEventListener('click', refresh);
byId('settings-button').addEventListener('click', () => {
  byId('settings-rpc').value = state.settings.rpcUrl;
  byId('settings-wallet').value = state.settings.walletAddress;
  byId('settings-profile').value = state.settings.challengerProfileAddress;
  byId('settings-interval').value = state.settings.refreshIntervalSeconds;
  byId('settings-dialog').showModal();
});
for (const id of ['settings-close', 'settings-cancel']) byId(id).addEventListener('click', () => byId('settings-dialog').close());
for (const id of ['review-close', 'review-done']) byId(id).addEventListener('click', () => byId('review-dialog').close());
byId('simulate-button').addEventListener('click', simulateReviewedReservation);
byId('settings-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  state.settings = { version: 1, rpcUrl: byId('settings-rpc').value.trim(), walletAddress: byId('settings-wallet').value.trim(), challengerProfileAddress: byId('settings-profile').value.trim(), refreshIntervalSeconds: Number(byId('settings-interval').value) };
  await window.fleetRentalBot.saveSettings(state.settings);
  byId('settings-dialog').close();
  scheduleRefresh();
  await refresh();
});
for (const id of ['dialog-close', 'dialog-cancel']) byId(id).addEventListener('click', () => byId('fleet-dialog').close());
byId('fleet-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const entry = formEntry();
  const duplicate = state.document.entries.find((item) => item.contractAddress === entry.contractAddress && item.id !== entry.id);
  if (duplicate) { byId('form-error').textContent = 'This contract is already in the watchlist.'; byId('form-error').hidden = false; return; }
  const index = state.document.entries.findIndex((item) => item.id === entry.id);
  index === -1 ? state.document.entries.push(entry) : state.document.entries.splice(index, 1, entry);
  await save();
  renderTable();
  byId('fleet-dialog').close();
});
byId('entry-delete').addEventListener('click', async () => {
  const id = byId('entry-id').value;
  state.document.entries = state.document.entries.filter((entry) => entry.id !== id);
  await save();
  renderTable();
  byId('fleet-dialog').close();
});

bootstrap().catch((error) => {
  byId('mode').textContent = 'STARTUP ERROR';
  byId('mode').title = error instanceof Error ? error.message : String(error);
});
