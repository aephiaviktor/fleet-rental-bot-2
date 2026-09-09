# Fleet Rental Bot 2

A clean next-generation SRSLY fleet reservation watchlist and manager for program
`SRSLYxcFnjd5jG2DpJw4as6UEyjwJQK1U4J1TD1hvZH`.

The legacy Fleet Rental Bot is intentionally not reused. Monitoring, review, and simulation
remain non-signing. The only automated signing path is explicitly enabled LCFS bidding.

A lancer hot-wallet secret can be configured per isolated instance. It is validated in the
Electron main process, encrypted with OS-backed `safeStorage`, and never returned to the
renderer after storage. The Settings-only privacy control masks the direct RPC URL by default on every
launch; public profile, wallet, and contract addresses and fleet notes remain visible.

Helius Sender settings include enable/disable, transaction priority fee in microLamports/CU,
Sender tip in SOL, and the LCFS lead time (five seconds by default). A fleet row is eligible
only when its LCFS checkbox is on. At the send time the contract is fetched again; the bot
submits exactly one current Next bid only when rental rate/day and Next bid are each less than
or equal to that row's configured maximum. Attempt state is persisted before submission to
prevent duplicate automatic sends for the same row and rental end across refreshes/restarts.
