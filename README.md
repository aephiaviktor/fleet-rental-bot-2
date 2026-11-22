# Fleet Rental Bot 2

A clean next-generation SRSLY fleet reservation watchlist and manager for program
`SRSLYxcFnjd5jG2DpJw4as6UEyjwJQK1U4J1TD1hvZH`.

The legacy Fleet Rental Bot is intentionally not reused. Monitoring, review, and simulation
remain non-signing. Automated signing requires an explicitly enabled LCFS or FCFS rule.

A lancer hot-wallet secret can be configured per isolated instance. It is validated in the
Electron main process, encrypted with OS-backed `safeStorage`, and never returned to the
renderer after storage. The Settings-only privacy control masks the direct RPC URL by default on every
launch; public profile, wallet, and contract addresses and fleet notes remain visible.

The application fails closed behind a non-dismissible Aephia access gate. It validates the
stored key with `GET https://api.aephia.com/token/validate`; only HTTP 204 unlocks the app.
Missing, rejected, unreadable, or temporarily unverifiable access blocks functional IPC and
pauses automated bidding. The key is revalidated every five minutes and checked before submission.

Helius Sender settings include enable/disable, transaction priority fee in microLamports/CU,
Sender tip in SOL, and the LCFS lead time (five seconds by default). The RPC Usage view records
actual wire attempts in the shared database and reports UTC-day totals by instance, safe RPC
method name, provider, and retry count without storing URLs, keys, parameters, wallets, or
transaction payloads. Every data column can be shown or hidden from the left sidebar. The default-visible **Ending In** column shows the active rental countdown as whole days and hours, and **LCFS** is also visible by default. A fleet row is eligible
only when its LCFS checkbox is on. At the send time the contract is fetched again; the bot
submits exactly one current Next bid only when rental rate/day and Next bid are each less than
or equal to that row's configured maximum. Attempt state is persisted before submission to
prevent duplicate automatic sends for the same row and rental end across refreshes/restarts.

## Bonus Strategy

Bonus Strategy lists fleets from Fleet Reservations for the current Player Profile. The
Min rate/d filter defaults to 3,000 ATLAS and the list puts the shortest minimum rental
durations first. Set a positive Max bid and enable FCFS on the fleets you want to bid on.
FCFS requires the signing wallet, Helius Sender, and a fleet marked enabled and safe.

The bot watches the next reservation slot during the active rental. It uses the contract's
minimum allowed duration and an opening ATLAS premium of one day's rate, raised if the
protocol minimum requires it. A rival can be overbid repeatedly while the active rental
has at least 24 hours left and the required premium fits the fleet's Max bid. The funding
check includes the premium and prepaid rent. A bid still holding at handover becomes
a paid rental.
