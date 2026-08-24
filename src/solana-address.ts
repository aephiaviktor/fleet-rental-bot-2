import { address } from '@solana/kit';

export function requireSolanaAddress(value: string, field: string): string {
  const trimmed = value.trim();
  try {
    address(trimmed);
    return trimmed;
  } catch {
    throw new Error(`${field} must be a valid Solana address`);
  }
}
