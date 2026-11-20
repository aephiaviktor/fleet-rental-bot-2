# Fleet Rental Bot 2

- Include the application version in every release commit title, for example: `Add contract terms columns (Fleet Rental Bot 2 0.1.48)`.
- Keep `package.json` and the root versions in `package-lock.json` aligned.
- For a requested app release, publish the Windows portable executable in a GitHub release tagged `v<version>` and titled `Fleet Rental Bot 2 v<version>`.
- The in-app updater requires `Fleet-Rental-Bot-2-<version>-portable.exe` and GitHub's SHA-256 asset digest. A source-only release is not a completed app release.
- Run the test suite, typecheck, and `git diff --check` before releasing. Preserve user settings, watchlist rules, instance identities, and LCFS transaction behavior unless explicitly requested.
