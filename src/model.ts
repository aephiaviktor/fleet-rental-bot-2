export const NEXT_GEN_SRSLY_PROGRAM_ID = 'SRSLYxcFnjd5jG2DpJw4as6UEyjwJQK1U4J1TD1hvZH';
export const ATLAS_DECIMALS = 8;
export const POINTS_DECIMALS = 8;

export type ReservationCurrency = 'ATLAS' | 'POINTS';
export type PositionStatus = 'none' | 'defending' | 'outbid' | 'activated';
export interface FleetWatchEntry {
  id: string;
  label: string;
  contractAddress: string;
  requestedDurationSeconds: number;
  estimatedNetValueAtlas: number | null;
  maximumRentalRateAtlasPerDay: number;
  maximumReservationBidAtlas: number;
  canSafelyOperate: boolean;
  enabled: boolean;
  comment: string;
  lcfs: boolean;
}

export interface FleetContractSnapshot {
  fleetName?: string;
  reservationsAllowed: boolean;
  minimumDurationSeconds: number;
  maximumDurationSeconds: number;
  rentalRateAtlasPerDay: number;
  activeRentalEndsAtMs: number | null;
  reservationCurrency: ReservationCurrency | null;
  reservationDefender: string | null;
  reservationBidAtlas: number | null;
  reservationBidPoints: number | null;
  minimumTakeoverBidAtlas: number | null;
  minimumTakeoverBidPoints: number | null;
  currentMinimumBidAtlas?: number | null;
  projectedExpiryTakeoverBidAtlas: number | null;
  reservationCreatedAtMs: number | null;
  fleetWeight: number;
  basePointsPerDay: number;
  effectivePointsPerDay: number;
}

export interface FleetTableRow {
  entry: FleetWatchEntry;
  snapshot: FleetContractSnapshot;
  position: WalletPosition;
  rentalCostAtlas: number;
  reservationPremiumPerDayAtlas: number | null;
  allInCostPerDayAtlas: number | null;
  defenderPrincipalRefundAtlas: number | null;
  ownerPremiumShareIfOutbidNowAtlas: number | null;
  reservationAgeMs: number | null;
  holdingFraction: number | null;
  bonusIfOutbidNowAtlas: number | null;
  projectedExpiryFloorBonusAtlas: number | null;
  maximumRemainingLockMs: number | null;
  endingIn: string;
  estimatedPoints: number;
  pointsPerThousandAtlas: number | null;
}

export interface WalletPosition {
  status: PositionStatus;
  atlasLocked: number;
  reservedAtMs: number | null;
}
