// Excerpt from the Al-Mizan codebase (private repository).
// Original path: client/src/db/drawerFold.ts
// Shared for portfolio review. Copyright (c) 2026 Rashad Eideh. All rights reserved.

import { addCents, compareMoney, subtractMoney, sumMoney, ZERO_MONEY, type Minor } from '@shared/money';
import type { DailyLedger } from './database';

/**
 * OPENING-02-R1 — THE ONE DRAWER FOLD, per physical currency.
 *
 * Pure: the write side (`ledger.ts` `drawerFold`, inside each money-moving
 * transaction) and the read side (`useDrawerBalance`) both call this over the
 * same `dailyLedger` rows, so the figure a sheet previews and the figure the
 * atomic check refuses on are one computation, not two mirrors.
 *
 * ── Quantities (never mixed) ────────────────────────────────────────────────
 *   · `liraMinor`  — physical SYP notes: Σ cash − the SYP book of dollar flows.
 *                    Exact, and NOT clamped: every writer books a dollar leg's
 *                    SYP value into the cash columns and the foreign columns
 *                    alike, so the subtraction removes exactly what it added.
 *   · `usdCents`   — physical dollar notes: Σ usdIn − Σ usdOut, in cents.
 *                    Authoritative only while `usdKnown`.
 *   · `foreignMinor` — the SYP BOOK of the dollar flows at each transaction's
 *                    own rate. Evidence of value; may be negative after rates
 *                    move; never availability and never divided by a rate.
 *   · `totalMinor` — the SYP book of the whole drawer (lira + that book). Not a
 *                    valuation at any single rate.
 *
 * ── Unknown, never zero ─────────────────────────────────────────────────────
 * Days recorded before R1 carry dollar legs only as SYP values (clamped, netted
 * and floored in ways no rate can undo), so their dollar QUANTITY is unknown.
 * `usdKnown` is false while any such row exists that no later physical dollar
 * count supersedes; a count books the difference to the counted quantity and
 * makes the fold authoritative from then on.
 */
export interface DrawerState {
  totalMinor: Minor;
  foreignMinor: Minor;
  liraMinor: Minor;
  usdCents: number;
  usdKnown: boolean;
}

function nonZero(value: Minor | undefined): boolean {
  return value !== undefined && compareMoney(value, ZERO_MONEY) !== 0;
}

/** The row carries native dollar columns. */
export function hasNativeUsd(row: Pick<DailyLedger, 'usdInCents' | 'usdOutCents'>): boolean {
  return row.usdInCents !== undefined || row.usdOutCents !== undefined;
}

/**
 * When this row last moved dollars by an unknown quantity: `''` for pre-R1
 * content (any count supersedes it), an ISO time for an R1-time legacy event,
 * `undefined` when its dollar movements are all known.
 */
export function legacyUsdMark(
  row: Pick<DailyLedger, 'usdInCents' | 'usdOutCents' | 'usdLegacy' | 'usdLegacyAt' | 'foreignCashInMinor' | 'foreignCashOutMinor'>,
): string | undefined {
  if (row.usdLegacyAt !== undefined) return row.usdLegacyAt;
  if (row.usdLegacy === 1) return '';
  if (!hasNativeUsd(row) && (nonZero(row.foreignCashInMinor) || nonZero(row.foreignCashOutMinor))) return '';
  return undefined;
}

export function foldDrawer(rows: readonly DailyLedger[]): DrawerState {
  const totalMinor = subtractMoney(
    sumMoney(rows.map((d) => d.cashInMinor)),
    sumMoney(rows.map((d) => d.cashOutMinor)),
  );
  // `?? ZERO_MONEY`: optional, un-backfilled columns; one `undefined` in a sum is NaN.
  const foreignMinor = subtractMoney(
    sumMoney(rows.map((d) => d.foreignCashInMinor ?? ZERO_MONEY)),
    sumMoney(rows.map((d) => d.foreignCashOutMinor ?? ZERO_MONEY)),
  );
  const liraMinor = subtractMoney(totalMinor, foreignMinor);

  let usdCents = 0;
  let latestLegacy: string | undefined;
  let latestCount: string | undefined;
  for (const row of rows) {
    usdCents = addCents(usdCents, row.usdInCents ?? 0, -(row.usdOutCents ?? 0));
    const mark = legacyUsdMark(row);
    if (mark !== undefined && (latestLegacy === undefined || mark > latestLegacy)) latestLegacy = mark;
    if (row.usdCountedAt !== undefined && (latestCount === undefined || row.usdCountedAt > latestCount)) {
      latestCount = row.usdCountedAt;
    }
  }
  const usdKnown = latestLegacy === undefined || (latestCount !== undefined && latestCount > latestLegacy);
  return { totalMinor, foreignMinor, liraMinor, usdCents, usdKnown };
}

/** What an outflow takes from the drawer, per physical currency. */
export interface CashOut {
  liraMinor: Minor;
  usdCents: number;
}

export interface CashAvailability {
  /** The lira leg exceeds the physical lira. */
  overLira: boolean;
  /** The dollar leg needs a dollar count first: the quantity held is unknown. */
  usdUnknown: boolean;
  /** The dollar leg exceeds the dollar notes held. */
  overUsd: boolean;
}

/**
 * THE availability question, per currency — exported so every sheet previews
 * the exact predicate its writer refuses on. Strictly `>`, so the last note is
 * spendable. No SYP-equivalent or book-value total takes part: a dollar leg is
 * compared with dollars, a lira leg with lira, and nothing else can authorise a
 * note that is not there or refuse one that is.
 */
export function cashAvailability(
  out: CashOut,
  drawer: Pick<DrawerState, 'liraMinor' | 'usdCents' | 'usdKnown'>,
): CashAvailability {
  const wantsUsd = out.usdCents > 0;
  return {
    overLira: compareMoney(out.liraMinor, ZERO_MONEY) > 0 && compareMoney(out.liraMinor, drawer.liraMinor) > 0,
    usdUnknown: wantsUsd && !drawer.usdKnown,
    overUsd: wantsUsd && drawer.usdKnown && out.usdCents > drawer.usdCents,
  };
}
