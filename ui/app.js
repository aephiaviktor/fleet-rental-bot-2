const state = { document: null, columns: [] };
const byId = (id) => document.getElementById(id);

function make(tag, text, className) {
  const element = document.createElement(tag);
  if (text != null) element.textContent = text;
  if (className) element.className = className;
  return element;
}

function displayValue(entry, columnId) {
  const days = entry.requestedDurationSeconds / 86400;
  const values = {
    label: entry.label,
    requestedDuration: `${days.toLocaleString(undefined, { maximumFractionDigits: 2 })} d`,
    operatingValue: entry.estimatedOperatingValueAtlas == null ? '—' : `${entry.estimatedOperatingValueAtlas} ATLAS`,
    maximumRentalRate: `${entry.maximumRentalRateAtlasPerDay} ATLAS/day`,
    maximumReservationBid: `${entry.maximumReservationBidAtlas} ATLAS`,
    recommendation: entry.enabled ? 'Waiting for live data' : 'Disabled',
    positionStatus: '—',
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
    actions.append(edit);
    row.append(actions);
    body.append(row);
  }
  byId('empty-state').hidden = state.document.entries.length !== 0;
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
  const [details, watchlist] = await Promise.all([
    window.fleetRentalBot.getBootstrap(), window.fleetRentalBot.loadWatchlist(),
  ]);
  state.document = watchlist.document;
  state.columns = watchlist.columns;
  byId('version').textContent = `v${details.version}`;
  byId('data-directory').textContent = details.dataDirectory;
  byId('mode').textContent = details.readOnly ? 'READ-ONLY' : 'LIVE';
  byId('mode').classList.add(details.readOnly ? 'safe' : 'live');
  renderColumnOptions();
  renderTable();
}

byId('add-button').addEventListener('click', () => openDialog());
byId('columns-button').addEventListener('click', () => { byId('columns-panel').hidden = !byId('columns-panel').hidden; });
byId('columns-done').addEventListener('click', () => { byId('columns-panel').hidden = true; });
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
