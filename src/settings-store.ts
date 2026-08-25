import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { requireSolanaAddress } from './solana-address.js';

export interface AppSettings {
  version: 1;
  aephiaApiKey: string;
  usturPlayerProfile: string;
  useRpcLimiter: boolean;
  rpcUrl: string;
  refreshIntervalSeconds: number;
  /** Retained only to migrate early 0.1.x settings; no longer shown in the UI. */
  walletAddress: string;
  /** Retained only to keep unsigned review compatibility during migration. */
  challengerProfileAddress: string;
}

export const DEFAULT_SETTINGS: AppSettings = {
  version: 1,
  aephiaApiKey: '',
  usturPlayerProfile: '',
  useRpcLimiter: true,
  rpcUrl: 'https://api.mainnet-beta.solana.com',
  refreshIntervalSeconds: 60,
  walletAddress: '',
  challengerProfileAddress: '',
};

export function validateSettings(value: unknown): AppSettings {
  if (typeof value !== 'object' || value === null) throw new Error('Settings must be an object');
  const candidate = value as Partial<AppSettings>;
  if (candidate.version !== 1) throw new Error('Unsupported settings version');
  if (typeof candidate.rpcUrl !== 'string') throw new Error('RPC URL is required');
  let url: URL;
  try { url = new URL(candidate.rpcUrl); } catch { throw new Error('RPC URL must be a valid URL'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('RPC URL must use HTTP or HTTPS');
  const aephiaApiKey = candidate.aephiaApiKey ?? '';
  if (typeof aephiaApiKey !== 'string') throw new Error('Aephia API key must be a string');
  const legacyProfile = candidate.challengerProfileAddress ?? '';
  const usturPlayerProfile = candidate.usturPlayerProfile ?? legacyProfile;
  if (typeof usturPlayerProfile !== 'string') throw new Error('USTUR player profile must be a string');
  const walletAddress = candidate.walletAddress ?? '';
  if (typeof walletAddress !== 'string') throw new Error('Wallet address must be a string');
  const refreshIntervalSeconds = candidate.refreshIntervalSeconds;
  if (!Number.isInteger(refreshIntervalSeconds) || refreshIntervalSeconds! < 15 || refreshIntervalSeconds! > 3600) {
    throw new Error('Refresh interval must be between 15 and 3600 seconds');
  }
  const normalizedProfile = usturPlayerProfile.trim() === '' ? '' : requireSolanaAddress(usturPlayerProfile, 'usturPlayerProfile');
  return {
    version: 1,
    aephiaApiKey: aephiaApiKey.trim(),
    usturPlayerProfile: normalizedProfile,
    useRpcLimiter: candidate.useRpcLimiter ?? true,
    rpcUrl: candidate.rpcUrl,
    refreshIntervalSeconds: refreshIntervalSeconds!,
    walletAddress: walletAddress.trim() === '' ? '' : requireSolanaAddress(walletAddress, 'walletAddress'),
    challengerProfileAddress: normalizedProfile,
  };
}

export async function loadSettings(filePath: string): Promise<AppSettings> {
  try { return validateSettings(JSON.parse(await readFile(filePath, 'utf8'))); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { ...DEFAULT_SETTINGS };
    throw error;
  }
}

export async function saveSettings(filePath: string, settings: unknown): Promise<void> {
  const validated = validateSettings(settings);
  await mkdir(dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(validated, null, 2)}\n`, { mode: 0o600 });
  await rename(temporaryPath, filePath);
}
