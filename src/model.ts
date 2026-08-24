export const NEXT_GEN_SRSLY_PROGRAM_ID = 'SRSLYxcFnjd5jG2DpJw4as6UEyjwJQK1U4J1TD1hvZH';
export const ATLAS_DECIMALS = 8;
export const POINTS_DECIMALS = 8;

export type ReservationCurrency = 'ATLAS' | 'POINTS';
export type PositionStatus = 'none' | 'defending' | 'outbid' | 'activated';
export type Recommendation =
  | 'reserve-now'
  | 'hold'
  | 'rebid'
  | 'stop'
  | 'too-expensive'
  | 'cannot-safely-operate';

export interface FleetWatchEntry {
  id: string;
  label: string;
  contractAddress: string;
  requestedDurationSeconds: number;
  estimatedOperatingValueAtlas: number | null;
  maximumRentalRateAtlasPerDay: number;
  maximumReservationBidAtlas: number;
  canSafelyOperate: boolean;
  enabled: boolean;
  comment: string;
}

export interface FleetContractSnapshot {
  rentalRateAtlasPerDay: number;
  activeRentalEndsAtMs: number | null;
  reservationCurrency: ReservationCurrency | null;
  reservationDefender: string | null;
  reservationBidAtlas: number | null;
  reservationBidPoints: number | null;
  minimumTakeoverBidAtlas: number | null;
  minimumTakeoverBidPoints: number | null;
  reservationCreatedAtMs: number | null;
  fleetWeight: number;
  basePointsPerDay: number;
  effectivePointsPerDay: number;
}

export interface WalletPosition {
  status: PositionStatus;
  atlasLocked: number;
  reservedAtMs: number | null;
}
