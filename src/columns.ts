export type ColumnGroup = 'fleet' | 'economics' | 'reservation' | 'loyalty' | 'decision';

export type ColumnId =
  | 'label'
  | 'rentalRate'
  | 'requestedDuration'
  | 'rentalCost'
  | 'operatingValue'
  | 'netValue'
  | 'maximumRentalRate'
  | 'maximumReservationBid'
  | 'reservationCurrency'
  | 'reservationBid'
  | 'minimumTakeoverBid'
  | 'atlasLocked'
  | 'reservationAge'
  | 'holdingFraction'
  | 'bonusIfOutbidNow'
  | 'projectedExpiryFloorBonus'
  | 'maximumRemainingLock'
  | 'fleetWeight'
  | 'estimatedPointsPerDay'
  | 'estimatedPoints'
  | 'pointsPerThousandAtlas'
  | 'existingPointsBalance'
  | 'positionStatus'
  | 'recommendation';

export interface ColumnDefinition {
  id: ColumnId;
  label: string;
  group: ColumnGroup;
  defaultVisible: boolean;
}

export const COLUMN_DEFINITIONS: readonly ColumnDefinition[] = [
  { id: 'label', label: 'Fleet', group: 'fleet', defaultVisible: true },
  { id: 'rentalRate', label: 'Rental rate', group: 'economics', defaultVisible: true },
  { id: 'requestedDuration', label: 'Requested duration', group: 'economics', defaultVisible: true },
  { id: 'rentalCost', label: 'Estimated rental cost', group: 'economics', defaultVisible: true },
  { id: 'operatingValue', label: 'Estimated operating value', group: 'economics', defaultVisible: true },
  { id: 'netValue', label: 'Estimated net value', group: 'economics', defaultVisible: true },
  { id: 'maximumRentalRate', label: 'Maximum rental rate', group: 'economics', defaultVisible: false },
  { id: 'maximumReservationBid', label: 'Maximum reservation bid', group: 'economics', defaultVisible: true },
  { id: 'reservationCurrency', label: 'Reservation currency', group: 'reservation', defaultVisible: false },
  { id: 'reservationBid', label: 'Current reservation bid', group: 'reservation', defaultVisible: true },
  { id: 'minimumTakeoverBid', label: 'Minimum takeover bid', group: 'reservation', defaultVisible: true },
  { id: 'atlasLocked', label: 'ATLAS locked', group: 'reservation', defaultVisible: true },
  { id: 'reservationAge', label: 'Reservation age', group: 'reservation', defaultVisible: false },
  { id: 'holdingFraction', label: 'Holding fraction', group: 'reservation', defaultVisible: true },
  { id: 'bonusIfOutbidNow', label: 'Bonus if outbid now', group: 'reservation', defaultVisible: true },
  { id: 'projectedExpiryFloorBonus', label: 'Projected expiry-floor bonus', group: 'reservation', defaultVisible: false },
  { id: 'maximumRemainingLock', label: 'Maximum remaining lock', group: 'reservation', defaultVisible: false },
  { id: 'fleetWeight', label: 'Fleet weight', group: 'loyalty', defaultVisible: true },
  { id: 'estimatedPointsPerDay', label: 'Estimated Points/day', group: 'loyalty', defaultVisible: true },
  { id: 'estimatedPoints', label: 'Estimated Points', group: 'loyalty', defaultVisible: true },
  { id: 'pointsPerThousandAtlas', label: 'Points per 1,000 ATLAS', group: 'loyalty', defaultVisible: false },
  { id: 'existingPointsBalance', label: 'Existing Points balance', group: 'loyalty', defaultVisible: false },
  { id: 'positionStatus', label: 'Position status', group: 'decision', defaultVisible: true },
  { id: 'recommendation', label: 'Recommended action', group: 'decision', defaultVisible: true },
] as const;

export const DEFAULT_VISIBLE_COLUMNS: readonly ColumnId[] = COLUMN_DEFINITIONS
  .filter((column) => column.defaultVisible)
  .map((column) => column.id);

export function normalizeVisibleColumns(value: unknown): ColumnId[] {
  const known = new Set<ColumnId>(COLUMN_DEFINITIONS.map((column) => column.id));
  if (!Array.isArray(value)) return [...DEFAULT_VISIBLE_COLUMNS];
  const normalized = value.filter((id): id is ColumnId => typeof id === 'string' && known.has(id as ColumnId));
  return normalized.length > 0 ? [...new Set(normalized)] : [...DEFAULT_VISIBLE_COLUMNS];
}
