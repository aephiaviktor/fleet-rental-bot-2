import { DatabaseSync } from 'node:sqlite';

const DAY_SECONDS = 86_400;

// OHLC includes an unfinished candle. Use the previous UTC day's close for a
// stable rate that was already available when the bid was placed.
export function bidPriceDay(bidAtMs: number): number {
  return (Math.floor(bidAtMs / (DAY_SECONDS * 1000)) - 1) * DAY_SECONDS;
}

export function readEarningsRates(db: DatabaseSync): Map<number, number> {
  const table = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='earnings_rates'").get();
  if (!table) return new Map();
  return new Map(db.prepare('SELECT day, atlas_per_sol FROM earnings_rates').all()
    .map(row => [Number(row.day), Number(row.atlas_per_sol)]));
}

async function dailyCloses(pair: 'SOLUSD' | 'ATLASUSD', since: number): Promise<Map<number, number>> {
  const url = `https://api.kraken.com/0/public/OHLC?pair=${pair}&interval=1440&since=${since}`;
  const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error('Historical market prices are unavailable.');
  const data = await response.json() as { error?: string[]; result?: Record<string, unknown> };
  const candles = data.result?.[pair];
  if (data.error?.length || !Array.isArray(candles)) throw new Error('Historical market prices could not be read.');
  const closes = new Map<number, number>();
  const lastCompleted = bidPriceDay(Date.now());
  for (const candle of candles) {
    if (!Array.isArray(candle)) continue;
    const [day, close, trades] = [Number(candle[0]), Number(candle[4]), Number(candle[7])];
    if (Number.isSafeInteger(day) && day % DAY_SECONDS === 0 && day <= lastCompleted
      && Number.isFinite(close) && close > 0 && trades > 0) closes.set(day, close);
  }
  return closes;
}

/** Save matched historical quotes so old APRs never depend on today's rate. */
export async function refreshEarningsRates(file: string, bidTimes: readonly number[]): Promise<void> {
  if (!bidTimes.length) return;
  const db = new DatabaseSync(file);
  try {
    db.exec('PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS earnings_rates(day INTEGER PRIMARY KEY, atlas_per_sol REAL NOT NULL)');
    const cached = readEarningsRates(db);
    // Kraken's public endpoint returns at most 720 daily candles.
    const oldest = bidPriceDay(Date.now()) - 718 * DAY_SECONDS;
    const missing = [...new Set(bidTimes.map(bidPriceDay))].filter(day => day >= oldest && !cached.has(day));
    if (!missing.length) return;
    const since = Math.min(...missing) - DAY_SECONDS;
    const [sol, atlas] = await Promise.all([dailyCloses('SOLUSD', since), dailyCloses('ATLASUSD', since)]);
    const save = db.prepare('INSERT OR IGNORE INTO earnings_rates VALUES (?,?)');
    for (const [day, solUsd] of sol) {
      const atlasUsd = atlas.get(day);
      if (atlasUsd) save.run(day, solUsd / atlasUsd);
    }
  } finally { db.close(); }
}
