import { DatabaseSync } from 'node:sqlite';

const DAY_SECONDS = 86_400;
const DAY_MS = DAY_SECONDS * 1000;
const MAX_WINDOW_DAYS = 92;
const AEPHIA_TOKEN_PRICES_URL = 'https://api.aephia.com/v1/market/tokens/';

// Use the last observation on the preceding UTC day, before the bid was placed.
export function bidPriceDay(bidAtMs: number): number {
  return (Math.floor(bidAtMs / DAY_MS) - 1) * DAY_SECONDS;
}

export function readEarningsRates(db: DatabaseSync): Map<number, number> {
  const table = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='earnings_aephia_rates'").get();
  if (!table) return new Map();
  return new Map(db.prepare('SELECT day, atlas_per_sol FROM earnings_aephia_rates').all()
    .map(row => [Number(row.day), Number(row.atlas_per_sol)]));
}

async function dailyPrices(token: 'atlas' | 'sol', fromDay: number, throughDay: number, apiKey: string): Promise<Map<number, number>> {
  const url = new URL(token, AEPHIA_TOKEN_PRICES_URL);
  const fromMs = fromDay * 1000;
  const toMs = (throughDay + DAY_SECONDS) * 1000 - 1;
  url.searchParams.set('from', new Date(fromMs).toISOString());
  url.searchParams.set('to', new Date(toMs).toISOString());
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json', 'User-Agent': 'Fleet-Rental-Bot-2' },
    redirect: 'error',
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`Aephia historical prices unavailable (HTTP ${response.status}).`);
  const data = await response.json() as { kind?: string; token?: string; columns?: unknown; rows?: unknown } | null;
  const columns = data?.columns;
  if (data?.kind !== 'token' || data.token !== token || !Array.isArray(columns) || !Array.isArray(data.rows)) {
    throw new Error('Invalid Aephia historical price series.');
  }
  const timestampIndex = columns.indexOf('ts');
  const priceIndex = columns.indexOf('price');
  if (timestampIndex < 0 || priceIndex < 0) throw new Error('Invalid Aephia historical price columns.');

  const latest = new Map<number, { timestamp: number; price: number }>();
  for (const row of data.rows) {
    if (!Array.isArray(row)) continue;
    const timestamp = row[timestampIndex], price = row[priceIndex];
    if (!Number.isSafeInteger(timestamp) || timestamp < fromMs || timestamp > toMs || !Number.isFinite(price) || price <= 0) continue;
    const day = Math.floor(timestamp / DAY_MS) * DAY_SECONDS;
    const previous = latest.get(day);
    if (!previous || timestamp > previous.timestamp) latest.set(day, { timestamp, price });
  }
  return new Map([...latest].map(([day, point]) => [day, point.price]));
}

/** Use a source-specific cache so saved Kraken prices cannot enter Aephia valuations. */
export async function refreshEarningsRates(file: string, bidTimes: readonly number[], apiKey: string): Promise<void> {
  if (!bidTimes.length) return;
  const key = apiKey.trim();
  if (!key) throw new Error('Aephia API key is required for historical prices.');
  const db = new DatabaseSync(file);
  try {
    db.exec('PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS earnings_aephia_rates(day INTEGER PRIMARY KEY, atlas_per_sol REAL NOT NULL)');
    const cached = readEarningsRates(db);
    const now = Date.now();
    const days = [...new Set(bidTimes.filter(at => Number.isSafeInteger(at) && at >= DAY_MS && at <= now).map(bidPriceDay))]
      .filter(day => !cached.has(day)).sort((a, b) => b - a);
    const save = db.prepare('INSERT OR IGNORE INTO earnings_aephia_rates VALUES (?,?)');
    for (let start = 0; start < days.length;) {
      const through = days[start];
      const windowStart = through - (MAX_WINDOW_DAYS - 1) * DAY_SECONDS;
      let end = start + 1;
      while (end < days.length && days[end] >= windowStart) end++;
      const [sol, atlas] = await Promise.all([
        dailyPrices('sol', days[end - 1], through, key), dailyPrices('atlas', days[end - 1], through, key),
      ]);
      for (const [day, solUsd] of sol) {
        const atlasUsd = atlas.get(day);
        if (!atlasUsd) continue;
        const ratio = solUsd / atlasUsd;
        if (Number.isFinite(ratio) && ratio > 0) save.run(day, ratio);
      }
      start = end;
    }
  } finally { db.close(); }
}
