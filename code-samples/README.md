# Code samples

Selected files from the private Al-Mizan codebase. They import modules that are not included here, so they are for reading, not for building.

| File | What to look at |
|---|---|
| [`money.ts`](money.ts) | Branded integer types for money, quantities and US cents; parsing from strings; one rounding function; overflow guards |
| [`money.test.ts`](money.test.ts) | Proves `0.1 + 0.2` is exact, plus rounding and invalid-input cases |
| [`drawerFold.ts`](drawerFold.ts) | Derives the cash drawer from the daily ledger, lira and dollars separately, and checks a payout against the right currency |
| [`checkoutRetry.excerpt.test.ts`](checkoutRetry.excerpt.test.ts) | Idempotent checkout: replays, mismatched replays, and two taps racing with `Promise.all` |
| [`nativeScanner.ts`](nativeScanner.ts) | ML Kit scanner: listener before camera, 300 ms silence re-arm, torch-off-first shutdown |
| [`backButton.ts`](backButton.ts) | Android back button handled without closing the app, safe under React StrictMode |
