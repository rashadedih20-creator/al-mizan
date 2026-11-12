// Excerpt from the Al-Mizan codebase (private repository).
// Original path: shared/money.ts
// Shared for portfolio review. Copyright (c) 2026 Rashad Eideh. All rights reserved.

/**
 * Exact decimal arithmetic for money and weighed quantities.
 *
 * Why this module exists
 * ----------------------
 * Prices and costs are `Decimal(10,2)` in PostgreSQL, but the moment a row
 * crosses into JavaScript it becomes an IEEE-754 double and stops being exact:
 * `0.1 + 0.2 !== 0.3`, and `19.99 * 3` is `59.97000000000001`. On a
 * pieces-only catalogue that error stayed invisible because every quantity was
 * an integer. Weighed products (`0.325 kg × 4250/kg`) multiply a price by a
 * fraction on every single line, so the error becomes visible in the till.
 *
 * The fix is to never do arithmetic on the decimal representation at all.
 * Every value is carried as a scaled **integer**:
 *
 *   - money    → minor units (2 dp) — `12.34` is `1234`
 *   - quantity → milli units (3 dp) — `0.325 kg` is `325`
 *
 * Integers below `Number.MAX_SAFE_INTEGER` are exact in IEEE-754, so addition,
 * subtraction and comparison are exact. Only division rounds, and it does so
 * explicitly (half-up, away from zero — the commercial convention).
 *
 * Parsing is string-based rather than `value * 100`, because the multiply is
 * itself lossy: `12.34 * 100` is `1233.9999999999998`. Prisma hands `Decimal`
 * columns to `res.json()` as strings, so the exact text is available and is
 * consumed directly.
 *
 * Writing back
 * ------------
 * Never persist `toNumber()`. `moneyToDecimalString()` produces the exact
 * decimal text, and Prisma accepts a string for any `Decimal` column — so a
 * value can make the full round trip DB → JS → DB without ever being a float.
 */

declare const scaledBrand: unique symbol;

/** A monetary amount in minor units (2 dp). Always an integer. */
export type Minor = number & { readonly [scaledBrand]: 'Minor' };

/** A quantity in milli units (3 dp). Always an integer. */
export type Milli = number & { readonly [scaledBrand]: 'Milli' };

/**
 * An amount of US DOLLARS in cents (2 dp). Always an integer. (CASH-01A1)
 *
 * ⚠️ A THIRD BRAND, NOT A `Minor`. Every `Minor` in this database is lira, and a
 * `Minor` holding dollars is the `stockMilli`-class type lie `Sale.usdRateSnapshot`
 * already refuses. An electronic USD transfer states what the customer actually
 * sent in the currency they sent it; the lira it was booked at is a SEPARATE
 * figure produced by `sypFromUsdCents` and stored beside it. The compiler is what
 * stops the two meeting in a `sumMoney`.
 */
export type UsdCents = number & { readonly [scaledBrand]: 'UsdCents' };

export const MONEY_DECIMALS = 2;
export const QUANTITY_DECIMALS = 3;

const MONEY_FACTOR = 100;
const QUANTITY_FACTOR = 1000;

/** Matches an optionally-signed decimal with either part omitted ('.5', '5.'). */
const DECIMAL_PATTERN = /^([+-]?)(\d*)(?:\.(\d*))?$/;

/**
 * Parses a decimal string into a scaled integer without ever forming an
 * intermediate float. Digits beyond `decimals` round half-up away from zero.
 */
function parseScaled(input: string, decimals: number): number {
  const text = input.trim();
  const match = DECIMAL_PATTERN.exec(text);
  if (!match || (!match[2] && !match[3])) {
    throw new RangeError(`Not a decimal value: "${input}"`);
  }

  const negative = match[1] === '-';
  const integerPart = match[2] || '0';
  const fractionRaw = match[3] ?? '';

  const fraction = fractionRaw.slice(0, decimals).padEnd(decimals, '0');
  // charCodeAt returns NaN past the end, and NaN >= 53 is false — so an
  // absent digit correctly rounds down.
  const carry = fractionRaw.charCodeAt(decimals) >= /* '5' */ 53 ? 1 : 0;

  const magnitude = Number(integerPart + fraction) + carry;
  if (!Number.isSafeInteger(magnitude)) {
    throw new RangeError(`Value exceeds safe integer precision: "${input}"`);
  }
  return negative ? -magnitude : magnitude;
}

/**
 * Normalises any inbound representation to a decimal string. Numbers go
 * through `toFixed`, which rounds correctly for every magnitude this app
 * handles and never emits exponent notation below 1e21.
 */
function toDecimalText(value: number | string, decimals: number): string {
  if (typeof value === 'string') return value;
  if (!Number.isFinite(value)) {
    throw new RangeError(`Not a finite number: ${value}`);
  }
  return value.toFixed(decimals);
}

/** Renders a scaled integer back to its exact decimal string. */
function formatScaled(scaled: number, decimals: number): string {
  const negative = scaled < 0;
  const digits = Math.abs(scaled).toString().padStart(decimals + 1, '0');
  const cut = digits.length - decimals;
  const text = `${digits.slice(0, cut)}.${digits.slice(cut)}`;
  return negative ? `-${text}` : text;
}

/**
 * Integer division rounding half-up away from zero. `denominator` must be
 * even for the `half` shortcut to stay exact — both scale factors are.
 */
function divideRoundHalfUp(numerator: number, denominator: number): number {
  const sign = numerator < 0 ? -1 : 1;
  const magnitude = Math.abs(numerator);
  const half = denominator / 2;
  return sign * Math.floor((magnitude + half) / denominator);
}

function assertMultiplicationIsSafe(a: number, b: number): void {
  if (!Number.isSafeInteger(a * b)) {
    throw new RangeError(
      `Arithmetic would lose precision (${a} × ${b} exceeds 2^53). ` +
        'This indicates an implausible price or quantity.',
    );
  }
}

/* ------------------------------------------------------------------ money */

/** Parses `12.34`, `"12.34"` or a Prisma Decimal's string form into minor units. */
export function money(value: number | string): Minor {
  return parseScaled(toDecimalText(value, MONEY_DECIMALS), MONEY_DECIMALS) as Minor;
}

/** Builds a Minor from an already-scaled integer (e.g. a stored minor-unit column). */
export function moneyFromMinor(minor: number): Minor {
  if (!Number.isSafeInteger(minor)) {
    throw new RangeError(`Minor units must be a safe integer, got ${minor}`);
  }
  return minor as Minor;
}

/** Exact decimal text — use this for every `Decimal` column write. */
export function moneyToDecimalString(value: Minor): string {
  return formatScaled(value, MONEY_DECIMALS);
}

/**
 * Lossy on purpose: for display and JSON only. The division reintroduces
 * float, so never feed the result back into further arithmetic.
 */
export function moneyToNumber(value: Minor): number {
  return value / MONEY_FACTOR;
}

export const ZERO_MONEY = 0 as Minor;

export function addMoney(...values: Minor[]): Minor {
  return sumMoney(values);
}

export function sumMoney(values: readonly Minor[]): Minor {
  let total = 0;
  for (const value of values) total += value;
  if (!Number.isSafeInteger(total)) {
    throw new RangeError('Money sum exceeded safe integer precision');
  }
  return total as Minor;
}

export function subtractMoney(a: Minor, b: Minor): Minor {
  return (a - b) as Minor;
}

export function negateMoney(value: Minor): Minor {
  return -value as Minor;
}

/** Clamps at zero — mirrors `Math.max(0, total - discount)` in sale calculation. */
export function clampMoneyAtZero(value: Minor): Minor {
  return (value < 0 ? 0 : value) as Minor;
}

export function compareMoney(a: Minor, b: Minor): -1 | 0 | 1 {
  return a < b ? -1 : a > b ? 1 : 0;
}

/* --------------------------------------------------------------- quantity */

/** Parses `2.5`, `"0.325"` or a Prisma Decimal's string form into milli units. */
export function quantity(value: number | string): Milli {
  return parseScaled(toDecimalText(value, QUANTITY_DECIMALS), QUANTITY_DECIMALS) as Milli;
}

export function quantityFromMilli(milli: number): Milli {
  if (!Number.isSafeInteger(milli)) {
    throw new RangeError(`Milli units must be a safe integer, got ${milli}`);
  }
  return milli as Milli;
}

/** Exact decimal text — use this for every quantity `Decimal` column write. */
export function quantityToDecimalString(value: Milli): string {
  return formatScaled(value, QUANTITY_DECIMALS);
}

/** Lossy on purpose: display and JSON only. */
export function quantityToNumber(value: Milli): number {
  return value / QUANTITY_FACTOR;
}

export const ZERO_QUANTITY = 0 as Milli;

export function addQuantity(a: Milli, b: Milli): Milli {
  return (a + b) as Milli;
}

export function subtractQuantity(a: Milli, b: Milli): Milli {
  return (a - b) as Milli;
}

export function sumQuantity(values: readonly Milli[]): Milli {
  let total = 0;
  for (const value of values) total += value;
  if (!Number.isSafeInteger(total)) {
    throw new RangeError('Quantity sum exceeded safe integer precision');
  }
  return total as Milli;
}

export function compareQuantity(a: Milli, b: Milli): -1 | 0 | 1 {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** True when the quantity is a whole number of units (no fractional part). */
export function isWholeQuantity(value: Milli): boolean {
  return value % QUANTITY_FACTOR === 0;
}

/* ------------------------------------------------------------ combination */

/**
 * `unitPrice × qty`, the one operation that has to round.
 *
 * Both operands are integers, so the product is exact; dividing out the
 * quantity scale is the single rounding step per line, half-up. Rounding once
 * per line (rather than letting float error accumulate across a cart) is what
 * keeps an invoice's line totals summing to its header total.
 */
export function lineTotal(unitPrice: Minor, qty: Milli): Minor {
  assertMultiplicationIsSafe(unitPrice, qty);
  return divideRoundHalfUp(unitPrice * qty, QUANTITY_FACTOR) as Minor;
}

/**
 * `total ÷ unitPrice` — the inverse of `lineTotal`, for value-driven entry.
 *
 * A merchant asked for "10,000 lira of tomatoes" is stating the LINE TOTAL and
 * asking for the quantity. Same argument order as `lineTotal` so the pair reads
 * as a pair, and the same `divideRoundHalfUp`, so a quantity derived from an
 * amount and an amount re-derived from that quantity round by one rule rather
 * than two.
 *
 * ⚠️ THE TWO ARE NOT EXACT INVERSES, AND THE RESIDUAL IS REAL. 10,000.00 at
 * 4,250.00/kg gives 2.353 kg, which `lineTotal` prices back at 10,000.25. The
 * quantity is what commits; the caller must show the total this function's
 * result actually produces rather than the amount that was typed. Forcing them
 * equal means overriding the line's unit price, which makes gross margin
 * editable at the counter with no audit trail.
 *
 * ⚠️ THE DENOMINATOR IS A PRICE AND MAY BE ODD, unlike the two scale factors
 * `divideRoundHalfUp` was written for. That is still exact: `n / d` lands on a
 * `.5` tie only when `d` is even, so an odd price admits no tie for the `half`
 * shortcut to mis-resolve — and `|n| + d/2` stays exactly representable (the
 * gap between doubles at 1e14 is 0.015625, far below 0.5).
 */
export function quantityForTotal(unitPrice: Minor, total: Minor): Milli {
  // Zero is reachable — a Phase 5-B descriptor row is written at ZERO_MONEY, and
  // `parseBackup` checks that `priceMinor` is finite but never that it is
  // positive. Left to divide, that is `Infinity` reaching a `Milli`.
  if (unitPrice <= 0) {
    throw new RangeError(`Unit price must be positive to derive a quantity, got ${unitPrice}`);
  }
  assertMultiplicationIsSafe(total, QUANTITY_FACTOR);
  return divideRoundHalfUp(total * QUANTITY_FACTOR, unitPrice) as Milli;
}

/* --------------------------------------------------------- USD transfers */

/**
 * The bounds a SYP-per-USD rate must sit inside — the same [1, 1e6] window
 * `features/pos/exchange.parseUsdRate` clamps the till's rate to. Declared here,
 * and imported there, so the ledger (which must not import `exchange`) and the
 * till cannot disagree about what a usable rate is.
 */
export const USD_RATE_MIN = 1;
export const USD_RATE_MAX = 1_000_000;

/** Builds `UsdCents` from an already-scaled integer (a stored or typed cent count). */
export function usdCentsFromInteger(cents: number): UsdCents {
  if (!Number.isSafeInteger(cents)) {
    throw new RangeError(`US cents must be a safe integer, got ${cents}`);
  }
  return cents as UsdCents;
}

/**
 * Whether `rate` can price an electronic USD transfer EXACTLY: finite, inside
 * [`USD_RATE_MIN`, `USD_RATE_MAX`], and representable at the SYP minor unit
 * (at most two decimal places).
 *
 * ⚠️ A RATE WITH A THIRD DECIMAL IS REFUSED, NEVER ROUNDED. The rate is half of
 * a stored conversion; rounding it silently would store a figure the operator
 * never typed and make the booked lira unreproducible from the row.
 */
export function isRepresentableUsdRate(rate: unknown): rate is number {
  if (typeof rate !== 'number' || !Number.isFinite(rate)) return false;
  if (rate < USD_RATE_MIN || rate > USD_RATE_MAX) return false;
  const scaled = parseScaled(rate.toFixed(MONEY_DECIMALS), MONEY_DECIMALS);
  return scaled / MONEY_FACTOR === rate;
}

/**
 * US cents → the lira `Minor` they are BOOKED at, for an electronic transfer.
 *
 * `cents × (SYP per USD)` is exactly the SYP minor figure (both sides carry a
 * factor of 100), so with the rate scaled to SYP minor units this is
 * `cents × rateMinor / 100`, rounded ONCE, half-up away from zero — the module's
 * convention — at 0.01 SYP. On an integer rate there is nothing to round.
 *
 * ⚠️ NOT `features/pos/exchange.fromUsd`. That one prices WHOLE DOLLAR NOTES and
 * floors away a fractional count by contract; a transfer carries cents, and
 * flooring them would book less than the customer sent.
 *
 * Throws on a rate `isRepresentableUsdRate` refuses and on a negative count —
 * the caller validates first and maps these to its own localized errors.
 */
export function sypFromUsdCents(cents: UsdCents, rate: number): Minor {
  if (!isRepresentableUsdRate(rate)) {
    throw new RangeError(`Not a usable SYP-per-USD rate: ${rate}`);
  }
  if (!Number.isSafeInteger(cents) || cents < 0) {
    throw new RangeError(`US cents must be a non-negative safe integer, got ${cents}`);
  }
  const rateMinor = parseScaled(rate.toFixed(MONEY_DECIMALS), MONEY_DECIMALS);
  assertMultiplicationIsSafe(cents, rateMinor);
  return divideRoundHalfUp(cents * rateMinor, MONEY_FACTOR) as Minor;
}

/* ------------------------------------------- USD notes and USD debts (OPENING-02) */

/**
 * A usable SYP-per-USD rate as SYP MINOR units per 1 USD — an exact integer,
 * because `isRepresentableUsdRate` admits at most two decimals. The same
 * scaling `sypFromUsdCents` applies internally, exported so exact settlement
 * arithmetic never forms `cents × rate` as a float.
 */
export function usdRateMinor(rate: number): number {
  if (!isRepresentableUsdRate(rate)) {
    throw new RangeError(`Not a usable SYP-per-USD rate: ${rate}`);
  }
  return parseScaled(rate.toFixed(MONEY_DECIMALS), MONEY_DECIMALS);
}

/** Parses typed dollars ("20", "20.5", "0.37") into US cents, exactly. Throws like `money`. */
export function usdCents(value: number | string): UsdCents {
  return parseScaled(toDecimalText(value, MONEY_DECIMALS), MONEY_DECIMALS) as UsdCents;
}

/** Exact decimal text of US cents ("20.50"). Display and parameters only. */
export function usdCentsToDecimalString(value: UsdCents): string {
  return formatScaled(value, MONEY_DECIMALS);
}

export const ZERO_CENTS = 0 as UsdCents;

/**
 * How many WHOLE US cents `sypMinor` covers at `rate`, rounded DOWN — never
 * credit a debt with more dollars than the lira actually paid for. Exact
 * (BigInt), so no magnitude this app accepts can lose precision.
 */
export function usdCentsCoveredBySyp(sypMinor: Minor, rate: number): UsdCents {
  if (!Number.isSafeInteger(sypMinor) || sypMinor < 0) {
    throw new RangeError(`SYP minor units must be a non-negative safe integer, got ${sypMinor}`);
  }
  const rateMinor = BigInt(usdRateMinor(rate));
  return Number((BigInt(sypMinor) * BigInt(MONEY_FACTOR)) / rateMinor) as UsdCents;
}

/* ------------------------------------------- physical dollar notes (OPENING-02-R1) */

/**
 * The exact number of US cents whose SYP value at `rate` (`sypFromUsdCents`,
 * half-up at 0.01 SYP) is `sypMinor` — or `undefined` when no whole cent count
 * has exactly that value.
 *
 * ⚠️ AN EXACT INVERSE, NEVER AN ESTIMATE. It exists for the one figure the till
 * produces — a count of notes times the rate THAT transaction was struck at —
 * and it refuses anything else. It must never be pointed at an accumulated SYP
 * balance or at today's rate: dividing a running total by a rate is exactly the
 * approximation the native dollar count replaced. A rate is at least 1 SYP, so
 * one cent is worth at least one minor unit and the mapping is one-to-one.
 */
export function exactUsdCentsForSyp(sypMinor: Minor, rate: number): UsdCents | undefined {
  if (!Number.isSafeInteger(sypMinor) || sypMinor < 0 || !isRepresentableUsdRate(rate)) return undefined;
  const rateMinor = BigInt(usdRateMinor(rate));
  const floor = (BigInt(sypMinor) * BigInt(MONEY_FACTOR)) / rateMinor;
  for (const candidate of [floor, floor + 1n]) {
    if (candidate > BigInt(Number.MAX_SAFE_INTEGER)) return undefined;
    const cents = Number(candidate) as UsdCents;
    try {
      if (sypFromUsdCents(cents, rate) === sypMinor) return cents;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/**
 * Signed cent arithmetic with an overflow check — the dollar fold, the count
 * adjustments and the drawer nets. A sum outside the safe-integer range is a
 * corrupted figure, never a big one, and is refused rather than rounded.
 */
export function addCents(...values: readonly number[]): number {
  let total = 0;
  for (const value of values) {
    if (!Number.isSafeInteger(value)) throw new RangeError(`US cents must be a safe integer, got ${value}`);
    total += value;
    if (!Number.isSafeInteger(total)) throw new RangeError('US cent sum overflowed');
  }
  return total;
}

/** Applies a rate expressed in basis points (10000 = 100%), rounding half-up. */
export function applyRate(value: Minor, basisPoints: number): Minor {
  if (!Number.isSafeInteger(basisPoints)) {
    throw new RangeError(`Basis points must be an integer, got ${basisPoints}`);
  }
  assertMultiplicationIsSafe(value, basisPoints);
  return divideRoundHalfUp(value * basisPoints, 10_000) as Minor;
}

/**
 * Splits `total` across `weights` so the parts sum to exactly `total`.
 *
 * Naive per-line rounding loses or invents minor units — three ways of 10.00
 * each round to 3.33 and sum to 9.99. This distributes the remainder to the
 * largest fractional parts (the largest-remainder method), so the invoice
 * always reconciles. Used to prorate a header-level discount across lines,
 * which is what makes per-line margin reporting add up to the invoice margin.
 */
export function allocateMoney(total: Minor, weights: readonly number[]): Minor[] {
  if (weights.length === 0) return [];
  if (weights.some((w) => w < 0)) {
    throw new RangeError('Allocation weights must be non-negative');
  }

  const weightTotal = weights.reduce((sum, w) => sum + w, 0);
  // No basis for weighting — split as evenly as the remainder allows.
  if (weightTotal === 0) {
    const base = Math.trunc(total / weights.length);
    const parts = weights.map(() => base as Minor);
    let remainder = total - base * weights.length;
    for (let i = 0; remainder !== 0; i = (i + 1) % parts.length) {
      const step = remainder > 0 ? 1 : -1;
      parts[i] = (parts[i] + step) as Minor;
      remainder -= step;
    }
    return parts;
  }

  const exact = weights.map((w) => (total * w) / weightTotal);
  const floors = exact.map((v) => Math.floor(v));
  const parts = floors.map((v) => v as Minor);

  let remainder = total - floors.reduce((sum, v) => sum + v, 0);
  const order = exact
    .map((value, index) => ({ index, fraction: value - floors[index] }))
    .sort((a, b) => b.fraction - a.fraction);

  for (let i = 0; remainder > 0; i = (i + 1) % order.length, remainder--) {
    const target = order[i].index;
    parts[target] = (parts[target] + 1) as Minor;
  }
  return parts;
}
