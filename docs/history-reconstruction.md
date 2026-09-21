# Rental history evidence

History is profile-scoped and incomplete where RPC retention or evidence is absent.
`RentalAccepted` events can represent automatic queue promotion without an explicit
`AcceptRental` instruction. Event-only discovery requires a resolved profile wallet
and the profile account in the transaction. Rental identity includes start time;
reused account addresses are not a single lifetime rental.

Winning premiums are reconstructed from ordered reservation events, including
replacement/cancellation and contract closure. Queue address must occur in the
acceptance transaction; borrower, contract and escrow must match uniquely. An
ambiguous same-slot cross-transaction ordering does not establish a winning bid.
Current active-account bid fields do not replace historical evidence.
Explicit direct acceptance proves zero auction premium, not a selected currency.

Currency and amount remain separate. Known zero is `0`, not unavailable. Both
on-chain amounts zero => `Unknown`, unless a matching signature-bound local intent
records `Atlas` or `Points`. Automated LCFS is currently ATLAS-only: before sending,
the signed transaction's public signature and actual bid amount/currency are
persisted. No signed wire or secrets are saved in history. An intent is not proof
of successful submission; it only enriches matching confirmed chain evidence.

Close rewards are divided by 1e8 and linked to the previous completed cycle, not
a replacement starting in the same second. Early cancellation rewards remain
unassigned when completion evidence is insufficient. Reward links are independent
of rental-start links; saved column visibility is preserved.

The `events-v2:` cursor namespace reprocesses old scans without deleting existing
history. All known rental accounts remain scan targets. Evidence is persisted and
replayed deterministically; failed scan/decode batches do not advance that target's
cursor. RPC range remains bounded (10 pages of 100), and incomplete scans report
an error rather than asserting complete historical coverage.
