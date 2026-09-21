# Public SRSLY transaction fixtures
Read-only mainnet transaction captures, 2026-09-21, SDK @sly-rentals/core 5.4.0.
Filenames are signature prefixes; full signatures remain in transaction.signatures.
Only public transaction, slot/block time, execution status, log messages,
inner instructions and lookup addresses are retained. No RPC endpoints or secrets.

- 3xJP/3aWU: MUD previous/current automatic rental starts; latter closes prior cycle.
- 264x/3tAh: MUD 710 ATLAS and zero-amount reservations.
- 5rfH/3ZT6/4nEu: ONI prior F2 automatic start, 1200-point close, 1000 ATLAS bid.
- 5Neg/3YVD: ONI Transport automatic start and 500 ATLAS bid.
- 5T21/2SoY: ONI Garter automatic start and zero-amount reservation.

Local currency intent is not derivable from zero/zero on-chain amounts.
