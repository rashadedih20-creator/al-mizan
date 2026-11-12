# Architecture

## Layers

```
React screens (features/*)
      │  read with useLiveQuery          write through one function per action
      ▼                                   ▼
Dexie tables  ◀──────────────  ledger / submissions / backup (db/*)
      │                                   │
IndexedDB on the device         shared/money.ts (integer money and quantities)
```

- **features/** — one folder per screen: point of sale, inventory, customers, suppliers, debts, expenses, cash, reports, settings.
- **db/** — the real "backend". Every action that moves money or stock is a function here, and each one runs in a single read-write transaction.
- **shared/** — money and quantity primitives used everywhere.
- **platform/** — the only place that knows about Android (Capacitor plugins, back button, printing, files).

## Startup

The app is wrapped in gates, each of which must pass before the next renders:

1. Redux store, theme, language and currency-display providers
2. **Database gate** — opens and, on first run, seeds the database
3. **License gate** — shows activation instead of the app if not activated
4. **Error boundary** — a crash shows a message, never a blank screen
5. **Session guard** — checks the signed-in account still exists
6. Router

## Data

- 25+ tables, normalized: sales and sale lines are separate; a credit note is a sale with its own number series.
- The schema has 25 versions. A shipped version is never edited; changes always add a new version so existing shops upgrade without losing data.
- Each sale line stores the product's cost at the time of sale, so past profit doesn't change when prices change.
- The business date is the phone's local date, not UTC.
- One row per day in the daily ledger holds revenue, cost of goods, expenses, cash in and out (lira and dollars). Balances and profit are derived from it.

## Recording a sale

1. Validate input (non-empty cart, non-negative payment).
2. Open one transaction over 11 tables.
3. If the operation id was already used: return the existing invoice when the content matches, refuse otherwise.
4. Re-read every product inside the transaction (the cart holds a possibly stale snapshot).
5. Sum quantities per product.
6. Reserve the invoice number; write the sale and its lines.
7. Reduce stock (negative stock is a warning, not a refusal: if the customer is holding the item, the count is what's wrong).
8. Write the cash movement and any customer debt.
9. Apply the day's ledger delta.
10. Write the audit-log entry.

## Passwords and licensing

- Passwords are stored as PBKDF2-SHA256 hashes with a random salt and 60,000 iterations, using a pure-JS library so the result is identical in secure and non-secure contexts.
- There are no roles: every account has the same access, and sign-in acts as a device lock.
- Commercial activation uses Ed25519 signatures. Only the public key ships in the app.
