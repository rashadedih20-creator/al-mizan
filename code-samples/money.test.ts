// Excerpt from the Al-Mizan codebase (private repository).
// Original path: shared/money.test.ts
// Shared for portfolio review. Copyright (c) 2026 Rashad Eideh. All rights reserved.

import { describe, it, expect } from 'vitest';
import {
  money,
  moneyToDecimalString,
  moneyToNumber,
  sumMoney,
  subtractMoney,
  clampMoneyAtZero,
  quantity,
  quantityToDecimalString,
  quantityToNumber,
  isWholeQuantity,
  lineTotal,
  quantityForTotal,
  applyRate,
  allocateMoney,
  type Minor,
} from './money';

describe('money parsing', () => {
  it('parses decimal strings exactly', () => {
    expect(money('12.34')).toBe(1234);
    expect(money('0.01')).toBe(1);
    expect(money('1000000.99')).toBe(100000099);
  });

  it('parses the values that break naive multiplication', () => {
    // `12.34 * 100` is 1233.9999999999998 — Math.round would rescue this one,
    // but the string path is exact by construction rather than by luck.
    expect(money('12.34')).toBe(1234);
    expect(money('1.005')).toBe(101); // half-up on the third digit
    expect(money('0.005')).toBe(1);
  });

  it('handles omitted integer and fraction parts', () => {
    expect(money('.5')).toBe(50);
    expect(money('5.')).toBe(500);
    expect(money('7')).toBe(700);
  });

  it('handles negatives symmetrically', () => {
    expect(money('-12.34')).toBe(-1234);
    expect(money('-0.005')).toBe(-1); // away from zero
  });

  it('truncating input rounds half-up, not toward even', () => {
    expect(money('2.345')).toBe(235);
    expect(money('2.344')).toBe(234);
  });

  it('rejects malformed input rather than yielding NaN', () => {
    expect(() => money('abc')).toThrow(RangeError);
    expect(() => money('')).toThrow(RangeError);
    expect(() => money(Number.NaN)).toThrow(RangeError);
    expect(() => money(Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });

  it('round-trips through the exact decimal string', () => {
    for (const text of ['0.00', '0.07', '12.34', '-99.99', '1000000.01']) {
      expect(moneyToDecimalString(money(text))).toBe(text);
    }
  });
});

describe('money arithmetic', () => {
  it('adds the classic float-error case exactly', () => {
    const result = sumMoney([money('0.1'), money('0.2')]);
    expect(result).toBe(30);
    expect(moneyToDecimalString(result)).toBe('0.30');
    // The whole point: the float version does not hold.
    expect(0.1 + 0.2).not.toBe(0.3);
  });

  it('stays exact across a long cart where floats would drift', () => {
    const lines = Array.from({ length: 1000 }, () => money('0.07'));
    expect(moneyToDecimalString(sumMoney(lines))).toBe('70.00');

    const floatSum = Array.from({ length: 1000 }, () => 0.07).reduce((a, b) => a + b, 0);
    expect(floatSum).not.toBe(70);
  });

  it('subtracts and clamps at zero', () => {
    expect(subtractMoney(money('10.00'), money('3.50'))).toBe(650);
    expect(clampMoneyAtZero(subtractMoney(money('3.00'), money('10.00')))).toBe(0);
  });

  it('converts to number only for display', () => {
    expect(moneyToNumber(money('12.34'))).toBeCloseTo(12.34, 10);
  });
});

describe('quantity', () => {
  it('parses three decimal places', () => {
    expect(quantity('0.325')).toBe(325);
    expect(quantity('2.5')).toBe(2500);
    expect(quantity(1)).toBe(1000);
  });

  it('round-trips exactly', () => {
    expect(quantityToDecimalString(quantity('0.325'))).toBe('0.325');
    expect(quantityToNumber(quantity('2.5'))).toBe(2.5);
  });

  it('identifies whole quantities for pieces-only validation', () => {
    expect(isWholeQuantity(quantity('3'))).toBe(true);
    expect(isWholeQuantity(quantity('3.001'))).toBe(false);
  });
});

describe('lineTotal', () => {
  it('prices a weighed line exactly', () => {
    // 0.325 kg at 4250.00/kg = 1381.25
    expect(moneyToDecimalString(lineTotal(money('4250.00'), quantity('0.325')))).toBe('1381.25');
  });

  it('matches integer behaviour for pieces', () => {
    expect(moneyToDecimalString(lineTotal(money('19.99'), quantity('3')))).toBe('59.97');
  });

  it('rounds half-up on the sub-minor remainder', () => {
    // 0.5 × 0.05 = 0.025 → 0.03
    expect(moneyToDecimalString(lineTotal(money('0.05'), quantity('0.5')))).toBe('0.03');
  });

  it('handles zero quantity', () => {
    expect(lineTotal(money('4250.00'), quantity('0'))).toBe(0);
  });

  it('refuses implausible magnitudes rather than silently losing precision', () => {
    expect(() => lineTotal(money('99999999.99'), quantity('99999999'))).toThrow(RangeError);
  });
});

describe('quantityForTotal', () => {
  it('inverts lineTotal exactly when the amount divides cleanly', () => {
    // 8500.00 at 4250.00/kg is exactly 2 kg, and back again.
    const qty = quantityForTotal(money('4250.00'), money('8500.00'));
    expect(quantityToDecimalString(qty)).toBe('2.000');
    expect(moneyToDecimalString(lineTotal(money('4250.00'), qty))).toBe('8500.00');
  });

  it('rounds half-up on the remainder, and the residual is real', () => {
    // The counter case: "give me 10,000 of tomatoes" at 4250.00/kg.
    // 10000 × 1000 ÷ 425000 = 2352.94… → 2353 milli = 2.353 kg.
    const qty = quantityForTotal(money('4250.00'), money('10000.00'));
    expect(qty).toBe(2353);
    expect(quantityToDecimalString(qty)).toBe('2.353');

    // ⚠️ Pricing that quantity back does NOT return the typed amount, and the
    // sheet must show this figure rather than the 10,000 that was asked for.
    expect(moneyToDecimalString(lineTotal(money('4250.00'), qty))).toBe('10000.25');
  });

  it('is unit-agnostic — a litre row derives identically to a kilo one', () => {
    // `Milli` is thousandths of the product's OWN unit, so the unit string never
    // enters the arithmetic. This is what makes one formula correct for `kg` and
    // `L` alike, with no per-unit branch to get wrong.
    expect(quantityForTotal(money('4000.00'), money('3000.00'))).toBe(750);
    expect(quantityToDecimalString(quantityForTotal(money('4000.00'), money('3000.00')))).toBe(
      '0.750',
    );
  });

  it('refuses a zero or negative unit price rather than returning Infinity', () => {
    // Reachable: a descriptor row is written at ZERO_MONEY, and `parseBackup`
    // never checks that a price is positive. Dividing would put `Infinity`
    // through `quantityFromMilli` in render, taking the till down.
    expect(() => quantityForTotal(0 as Minor, money('10000.00'))).toThrow(RangeError);
    expect(() => quantityForTotal(money('-1.00'), money('10000.00'))).toThrow(RangeError);
  });

  it('refuses an implausible amount rather than silently losing precision', () => {
    expect(() => quantityForTotal(money('0.01'), money('99999999999.99'))).toThrow(RangeError);
  });

  it('returns zero for a zero amount', () => {
    expect(quantityForTotal(money('4250.00'), money('0'))).toBe(0);
  });
});

describe('applyRate', () => {
  it('applies a percentage in basis points', () => {
    expect(moneyToDecimalString(applyRate(money('100.00'), 1500))).toBe('15.00');
    expect(moneyToDecimalString(applyRate(money('19.99'), 1000))).toBe('2.00');
  });
});

describe('allocateMoney', () => {
  it('never loses or invents a minor unit', () => {
    const parts = allocateMoney(money('10.00'), [1, 1, 1]);
    expect(parts.map(moneyToDecimalString)).toEqual(['3.34', '3.33', '3.33']);
    expect(sumMoney(parts)).toBe(money('10.00'));
  });

  it('weights proportionally and still reconciles', () => {
    const total = money('100.00');
    const parts = allocateMoney(total, [4250, 1299, 875]);
    expect(sumMoney(parts)).toBe(total);
  });

  it('splits evenly when every weight is zero', () => {
    const parts = allocateMoney(money('1.00'), [0, 0, 0]);
    expect(sumMoney(parts)).toBe(money('1.00'));
  });

  it('returns an empty allocation for no lines', () => {
    expect(allocateMoney(money('10.00'), [])).toEqual([]);
  });

  it('reconciles across many randomised splits', () => {
    for (let run = 0; run < 200; run++) {
      const total = money(String((run * 37) % 5000)) as Minor;
      const weights = [3, 7, 11, 13].map((w) => (w * (run + 1)) % 97);
      expect(sumMoney(allocateMoney(total, weights))).toBe(total);
    }
  });

  it('rejects negative weights', () => {
    expect(() => allocateMoney(money('10.00'), [1, -1])).toThrow(RangeError);
  });

  /**
   * ⚠️ A NEGATIVE TOTAL RECONCILES TOO, and this is pinned rather than inferred.
   *
   * Every caller until the rounding adjuster passed a header DISCOUNT, which is
   * non-negative by construction — so the whole function's behaviour below zero
   * was untested. `Sale.roundingAdjustmentMinor` is SIGNED (a value-driven line
   * priced at 4,250/kg overshoots the ask, where one at 30,000/kg undershoots),
   * and `buildCreditNote` prorates it through here, so the negative branch is now
   * live money.
   *
   * `Math.floor` rounds toward −∞ rather than toward zero, so the parts are not
   * mirror images of the positive case — the remainder lands on different lines.
   * What must hold, and all that must hold, is that they SUM to exactly the
   * total. That is what makes a fully-returned invoice refund what it collected.
   */
  it('reconciles a NEGATIVE total, the rounding adjuster case', () => {
    const total = money('-10.00');
    const parts = allocateMoney(total, [1, 1, 1]);
    expect(sumMoney(parts)).toBe(total);

    // An odd figure over uneven weights — where a naive floor would strand a unit.
    const odd = money('-0.07');
    expect(sumMoney(allocateMoney(odd, [4250, 1299, 875]))).toBe(odd);

    // The same randomised sweep as above, driven negative.
    for (let run = 0; run < 200; run++) {
      const negative = money(String(-((run * 37) % 5000))) as Minor;
      const weights = [3, 7, 11, 13].map((w) => (w * (run + 1)) % 97);
      expect(sumMoney(allocateMoney(negative, weights))).toBe(negative);
    }
  });
});
