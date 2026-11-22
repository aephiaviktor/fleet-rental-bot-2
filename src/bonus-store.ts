import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { requireSolanaAddress } from './solana-address.js';

export const DEFAULT_BONUS_MINIMUM_RATE = 3_000;

export interface BonusRule {
  contractAddress: string;
  fcfs: boolean;
  maximumBidAtlas: number;
  /** Explicit FCFS authorization from the market list, also valid outside the watchlist. */
  market?: true;
}

export interface BonusStrategySettings {
  minimumRateAtlasPerDay: number;
  rules: BonusRule[];
}

export interface PendingBonusBid {
  signature: string;
  lastValidBlockHeight: string;
}

function validAtlas(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    && Number.isSafeInteger(Math.round(value * 100_000_000)) && Number(value.toFixed(8)) === value;
}

function validateSettings(value: BonusStrategySettings): BonusStrategySettings {
  if (!value || !validAtlas(value.minimumRateAtlasPerDay) || !Array.isArray(value.rules)) {
    throw new Error('Bonus Strategy requires a valid minimum rate and fleet rules.');
  }
  const contracts = new Set<string>();
  const rules = value.rules.map(rule => {
    if (!rule || !validAtlas(rule.maximumBidAtlas) || typeof rule.fcfs !== 'boolean') {
      throw new Error('Enter a valid Max bid for each Bonus Strategy fleet.');
    }
    if (rule.fcfs && rule.maximumBidAtlas === 0) throw new Error('Set a positive Max bid before enabling FCFS.');
    const contractAddress = requireSolanaAddress(rule.contractAddress, 'Rental contract');
    if (contracts.has(contractAddress)) throw new Error('Bonus Strategy fleet rules must be unique.');
    contracts.add(contractAddress);
    return { contractAddress, fcfs: rule.fcfs, maximumBidAtlas: rule.maximumBidAtlas, ...(rule.market === true ? { market: true as const } : {}) };
  });
  return { minimumRateAtlasPerDay: value.minimumRateAtlasPerDay, rules };
}

async function readJson<T>(file: string): Promise<T | undefined> {
  try { return JSON.parse(await readFile(file, 'utf8')) as T; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
}

function settingsPath(directory: string, profile: string): string {
  return path.join(directory, 'bonus-strategy', `${requireSolanaAddress(profile, 'Player Profile')}.json`);
}

export async function loadBonusSettings(directory: string, profile: string): Promise<BonusStrategySettings> {
  const saved = profile ? await readJson<BonusStrategySettings>(settingsPath(directory, profile)) : undefined;
  return saved === undefined ? { minimumRateAtlasPerDay: DEFAULT_BONUS_MINIMUM_RATE, rules: [] } : validateSettings(saved);
}

export async function saveBonusSettings(directory: string, profile: string, settings: BonusStrategySettings): Promise<BonusStrategySettings> {
  const validated = validateSettings(settings);
  await writeJson(settingsPath(directory, profile), validated);
  return validated;
}

function pendingPath(directory: string, wallet: string, contract: string): string {
  return path.join(directory, 'bonus-pending', `${requireSolanaAddress(wallet, 'Wallet')}-${requireSolanaAddress(contract, 'Rental contract')}.json`);
}

export const readPendingBonusBid = (directory: string, wallet: string, contract: string) =>
  readJson<PendingBonusBid>(pendingPath(directory, wallet, contract));

export const savePendingBonusBid = (directory: string, wallet: string, contract: string, pending: PendingBonusBid) =>
  writeJson(pendingPath(directory, wallet, contract), pending);

export const clearPendingBonusBid = (directory: string, wallet: string, contract: string) =>
  rm(pendingPath(directory, wallet, contract), { force: true });
