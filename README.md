# Fleet Rental Bot 2

A clean next-generation SRSLY fleet reservation watchlist and manager for program
`SRSLYxcFnjd5jG2DpJw4as6UEyjwJQK1U4J1TD1hvZH`.

The legacy Fleet Rental Bot is intentionally not reused. Initial development is read-only;
transaction submission will be added only after contract behavior and safety guards are verified.

A lancer hot-wallet secret can be configured per isolated instance. It is validated in the
Electron main process, encrypted with OS-backed `safeStorage`, and never returned to the
renderer after storage. This prepares signer identity only; signing and submission remain
disabled. The Settings-only privacy control masks the direct RPC URL by default on every
launch; public profile, wallet, and contract addresses and fleet notes remain visible.

Basic Helius Sender preferences can also be prepared in Settings: enable/disable Sender,
transaction priority fee in microLamports/CU, and Sender tip in SOL. These values are stored
for the future transaction path but do not enable signing or submission.
