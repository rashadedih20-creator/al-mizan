// Excerpt from the Al-Mizan codebase (private repository).
// Original path: client/src/db/checkoutRetry.test.ts (one describe block)
// Shared for portfolio review. Copyright (c) 2026 Rashad Eideh. All rights reserved.

// The helpers seed(), cashSale() and footprint() are defined earlier in the original file.
// footprint() snapshots every table, so 'writes nothing' is checked against the whole database.

import 'fake-indexeddb/auto';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { money, quantity, moneyToDecimalString, usdCentsFromInteger } from '@shared/money';
import { db, newId, businessDateOf, type Product, type PendingSubmission } from './database';
import {
  recordSale,
  recordCreditNote,
  saleSubmissionOf,
  LedgerError,
  type CheckoutInput,
} from './ledger';
import {
  submitSale,
  submitCollection,
  finishSubmission,
  settleFailedSubmission,
  readInterruptedSubmissions,
  replaySubmission,
  discardSubmission,
} from './submissions';
import { exportBackup, exportBackupChunks, restoreFromFile, countUnresolvedSubmissions } from './backup';

// ... helpers omitted ...


describe('recordSale — one operation id per logical checkout', () => {
  it('the same id and the same submission returns the committed invoice and writes nothing', async () => {
    const { product } = await seed();
    const opId = newId();
    const first = await recordSale(cashSale(product, opId));
    expect(first.duplicate).toBe(false);
    expect(first.sale.opId).toBe(opId);
    expect(first.sale.opDigest).toMatch(/^v1:[0-9a-f]{16}$/);
    const after = await footprint();

    const again = await recordSale(cashSale(product, opId));
    expect(again.duplicate).toBe(true);
    expect(again.sale.id).toBe(first.sale.id);
    expect(again.sale.saleNo).toBe(first.sale.saleNo);
    expect(again.warnings).toEqual([]);
    expect(await footprint()).toEqual(after);
  });

  it('a replay is returned even when today\'s state would now refuse the submission (archived product)', async () => {
    const { product } = await seed();
    const opId = newId();
    const first = await recordSale(cashSale(product, opId));
    await db.products.update(product.id, { active: 0 });

    const again = await recordSale(cashSale(product, opId));
    expect(again).toMatchObject({ duplicate: true, sale: { id: first.sale.id } });
    // …while a NEW submission is refused on the same state.
    await expect(recordSale(cashSale(product, newId()))).rejects.toMatchObject({ code: 'INACTIVE_PRODUCT' });
  });

  it('the same id with a different submission is refused and writes nothing', async () => {
    const { product, clientId } = await seed();
    const opId = newId();
    await recordSale(cashSale(product, opId));
    const before = await footprint();

    const variants: (CheckoutInput & { opId: string })[] = [
      cashSale(product, opId, '3'),
      { ...cashSale(product, opId), paidMinor: money('400.00') },
      { ...cashSale(product, opId), discountMinor: money('1.00') },
      { ...cashSale(product, opId), clientId },
      { ...cashSale(product, opId), paymentMethod: 'card', paidMinor: money('200.00') },
      { ...cashSale(product, opId), lines: [{ product, qtyMilli: quantity('2'), unitPriceMinor: money('90.00') }] },
    ];
    for (const variant of variants) {
      await expect(recordSale(variant)).rejects.toMatchObject({ code: 'DUPLICATE_OPERATION' });
    }
    expect(await footprint()).toEqual(before);
  });

  it('a transfer replay must carry the same transfer, rate included', async () => {
    const { product } = await seed();
    const opId = newId();
    const input: CheckoutInput & { opId: string } = {
      lines: [{ product, qtyMilli: quantity('3') }],
      discountMinor: money('0'),
      paidMinor: money('300.00'),
      paymentMethod: 'transfer',
      usdRateSnapshot: RATE,
      transfer: { provider: 'mtnCash', currency: 'SYP', reference: 'M-1' },
      opId,
    };
    await recordSale(input);
    expect((await recordSale(input)).duplicate).toBe(true);
    await expect(
      recordSale({ ...input, transfer: { provider: 'mtnCash', currency: 'SYP', reference: 'M-2' } }),
    ).rejects.toMatchObject({ code: 'DUPLICATE_OPERATION' });
    expect(await db.sales.count()).toBe(1);
  });

  it('two submissions of one tap racing each other commit once', async () => {
    const { product } = await seed();
    const opId = newId();
    const results = await Promise.all([recordSale(cashSale(product, opId)), recordSale(cashSale(product, opId))]);
    expect(results.map((r) => r.duplicate).sort()).toEqual([false, true]);
    expect(new Set(results.map((r) => r.sale.id)).size).toBe(1);
    expect(await db.sales.count()).toBe(1);
    expect((await db.products.get(product.id))!.stockMilli).toBe(quantity('48'));
  });

  // ... more cases omitted ...
});
