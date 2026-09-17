import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { requireSolanaAddress } from './solana-address.js';

export interface AppSettings {
  version: 1;
  aephiaApiKey: string;
  playerProfile: string;
  /** Legacy flag retained only for settings-file compatibility; the general limiter is no longer used. */
  useRpcLimiter: boolean;
  rpcUrl: string;
  rpcRequestsPerSecond: number;
  /** Legacy fixed interval retained only for settings-file compatibility; adaptive scheduling is authoritative. */
  refreshIntervalSeconds: number;
  useHeliusSender: boolean;
  transactionPriorityFeeMicroLamports: number;
  heliusSenderTipSol: number;
  lcfsLeadTimeSeconds: number;
  /** Retained only to migrate early 0.1.x settings; no longer shown in the UI. */
  walletAddress: string;
  /** Player's main (hardware/primary) wallet; treated as self by the LCFS self-defender guard. */
  mainWalletAddress: string;
  /** Player's lancer (permissioned) wallet; also treated as self by the LCFS self-defender guard. */
  lancerWalletAddress: string;
  /** Retained only to keep unsigned review compatibility during migration. */
  challengerProfileAddress: string;
}

export const DEFAULT_SETTINGS: AppSettings = {
  version: 1,
  aephiaApiKey: '',
  playerProfile: '',
  useRpcLimiter: false,
  rpcUrl: 'https://api.mainnet-beta.solana.com',
  rpcRequestsPerSecond: 5,
  refreshIntervalSeconds: 60,
  useHeliusSender: false,
  transactionPriorityFeeMicroLamports: 1_000,
  heliusSenderTipSol: 0.0002,
  lcfsLeadTimeSeconds: 5,
  walletAddress: '',
  mainWalletAddress: '',
  lancerWalletAddress: '',
  challengerProfileAddress: '',
};

export function validateSettings(value: unknown): AppSettings {
  if (typeof value !== 'object' || value === null) throw new Error('Settings must be an object');
  const candidate = value as Partial<AppSettings> & { usturPlayerProfile?: unknown };
  if (candidate.version !== 1) throw new Error('Unsupported settings version');
  if (typeof candidate.rpcUrl !== 'string') throw new Error('RPC URL is required');
  let url: URL;
  try { url = new URL(candidate.rpcUrl); } catch { throw new Error('RPC URL must be a valid URL'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('RPC URL must use HTTP or HTTPS');
  const aephiaApiKey = candidate.aephiaApiKey ?? '';
  if (typeof aephiaApiKey !== 'string') throw new Error('Aephia API key must be a string');
  const legacyProfile = candidate.usturPlayerProfile ?? candidate.challengerProfileAddress ?? '';
  const playerProfile = candidate.playerProfile ?? legacyProfile;
  if (typeof playerProfile !== 'string') throw new Error('Player Profile must be a string');
  const walletAddress = candidate.walletAddress ?? '';
  if (typeof walletAddress !== 'string') throw new Error('Wallet address must be a string');
  const mainWalletAddress = candidate.mainWalletAddress ?? '';
  if (typeof mainWalletAddress !== 'string') throw new Error('Main wallet address must be a string');
  const lancerWalletAddress = candidate.lancerWalletAddress ?? '';
  if (typeof lancerWalletAddress !== 'string') throw new Error('Lancer wallet address must be a string');
  const rpcRequestsPerSecond = candidate.rpcRequestsPerSecond ?? 5;
  if (!Number.isFinite(rpcRequestsPerSecond) || rpcRequestsPerSecond < 1 || rpcRequestsPerSecond > 10) {
    throw new Error('Fleet Rental Bot 2 RPC rate must be between 1 and 10 requests per second');
  }
  const refreshIntervalSeconds = candidate.refreshIntervalSeconds;
  if (!Number.isInteger(refreshIntervalSeconds) || refreshIntervalSeconds! < 15 || refreshIntervalSeconds! > 3600) {
    throw new Error('Refresh interval must be between 15 and 3600 seconds');
  }
  const transactionPriorityFeeMicroLamports = candidate.transactionPriorityFeeMicroLamports ?? 1_000;
  if (!Number.isInteger(transactionPriorityFeeMicroLamports) || transactionPriorityFeeMicroLamports < 1) {
    throw new Error('Transaction priority fee must be a positive integer');
  }
  const heliusSenderTipSol = candidate.heliusSenderTipSol ?? 0.0002;
  if (!Number.isFinite(heliusSenderTipSol) || heliusSenderTipSol < 0) {
    throw new Error('Helius Sender tip must be a non-negative number');
  }
  const useHeliusSender = candidate.useHeliusSender ?? false;
  if (typeof useHeliusSender !== 'boolean') throw new Error('Use Helius Sender must be a boolean');
  if (useHeliusSender && heliusSenderTipSol < 0.0002) {
    throw new Error('Helius Sender tip must be at least 0.0002 SOL when enabled');
  }
  const configuredLcfsLeadTimeSeconds = candidate.lcfsLeadTimeSeconds ?? 5;
  if (!Number.isInteger(configuredLcfsLeadTimeSeconds) || configuredLcfsLeadTimeSeconds < 0) {
    throw new Error('LCFS lead time must be a non-negative integer number of seconds');
  }
  const lcfsLeadTimeSeconds = Math.max(5, configuredLcfsLeadTimeSeconds);
  const normalizedProfile = playerProfile.trim() === '' ? '' : requireSolanaAddress(playerProfile, 'playerProfile');
  return {
    version: 1,
    aephiaApiKey: aephiaApiKey.trim(),
    playerProfile: normalizedProfile,
    useRpcLimiter: false,
    rpcUrl: candidate.rpcUrl,
    rpcRequestsPerSecond,
    refreshIntervalSeconds: refreshIntervalSeconds!,
    useHeliusSender,
    transactionPriorityFeeMicroLamports,
    heliusSenderTipSol,
    lcfsLeadTimeSeconds,
    walletAddress: walletAddress.trim() === '' ? '' : requireSolanaAddress(walletAddress, 'walletAddress'),
    mainWalletAddress: mainWalletAddress.trim() === '' ? '' : requireSolanaAddress(mainWalletAddress, 'mainWalletAddress'),
    lancerWalletAddress: lancerWalletAddress.trim() === '' ? '' : requireSolanaAddress(lancerWalletAddress, 'lancerWalletAddress'),
    challengerProfileAddress: normalizedProfile,
  };
}

/**
 * Owned wallet addresses (the configured signer plus the player profile's main
 * and lancer/permissioned wallets). The LCFS self-defender guard treats any of
 * these as "me" when it appears as the on-chain reservation defender.
 */
export function ownedWalletAddresses(settings: AppSettings): string[] {
  const seen = new Set<string>();
  const owned: string[] = [];
  for (const value of [settings.walletAddress, settings.mainWalletAddress, settings.lancerWalletAddress]) {
    const normalized = value.trim();
    if (normalized && !seen.has(normalized)) {
      seen.add(normalized);
      owned.push(normalized);
    }
  }
  return owned;
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
