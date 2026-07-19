import {
  InventoryActionType,
  Prisma,
  PurchaseStatus,
  PurchaseType,
} from '@prisma/client';
import { PurchaseService } from './purchase.service';

describe('PurchaseService purchase persistence helpers', () => {
  const user = {
    staffId: 'staff-1',
    accountId: 'owner-1',
    type: 'owner',
  } as const;

  function service() {
    return new PurchaseService(
      {} as never,
      {} as never,
      {
        record: jest.fn().mockResolvedValue(null),
      } as never,
    ) as unknown as PurchaseService &
      Record<string, (...args: unknown[]) => unknown>;
  }

  it('parses complete purchase payloads with items and expenses', () => {
    const parsed = service().parseCreatePurchaseBody({
      purchaseDate: '2026-07-18',
      payeeId: 'payee-1',
      invoiceNumber: 'INV-1',
      type: PurchaseType.CHECK,
      status: PurchaseStatus.OPEN,
      manualEntry: { cost: '10.00', retail: '20.00', margin: '50.00' },
      items: [
        {
          productId: 'product-1',
          quantity: 2,
          unitsPerCase: 10,
          caseCost: '50.00',
          caseDiscount: '5.00',
          newRetail: '8.00',
          entryType: 'purchase',
        },
      ],
      expenses: [{ description: 'Freight', amount: '3.25' }],
    }) as {
      type: PurchaseType;
      items: Array<{
        productId: string;
        quantity: number;
        unitsPerCase: number;
      }>;
      expenses: Array<{ description: string; amount: Prisma.Decimal }>;
    };

    expect(parsed.type).toBe(PurchaseType.CHECK);
    expect(parsed.items).toMatchObject([
      { productId: 'product-1', quantity: 2, unitsPerCase: 10 },
    ]);
    expect(parsed.expenses[0].amount.toFixed(2)).toBe('3.25');
  });

  it('calculates authoritative totals from saved line data and expenses', () => {
    const totals = service().calculatePurchaseTotals(
      [
        {
          extendedCost: new Prisma.Decimal('90.00'),
          extendedRetail: new Prisma.Decimal('160.00'),
        },
      ],
      [{ amount: new Prisma.Decimal('3.25') }],
      {
        cost: new Prisma.Decimal('10.00'),
        retail: new Prisma.Decimal('20.00'),
        margin: new Prisma.Decimal('50.00'),
      },
      {
        freightAmount: new Prisma.Decimal(0),
        feeAmount: new Prisma.Decimal(0),
        taxAmount: new Prisma.Decimal(0),
        discountAmount: new Prisma.Decimal(0),
        rebateAmount: new Prisma.Decimal(0),
      },
    ) as {
      costSubtotal: Prisma.Decimal;
      retailTotal: Prisma.Decimal;
      totalCost: Prisma.Decimal;
    };

    expect(totals.costSubtotal.toFixed(2)).toBe('100.00');
    expect(totals.retailTotal.toFixed(2)).toBe('180.00');
    expect(totals.totalCost.toFixed(2)).toBe('103.25');
  });

  it('calculates purchase and return inventory effects per product', () => {
    const effects = service().inventoryEffectsFromItems([
      {
        productId: 'product-1',
        quantity: 2,
        unitsPerCase: 10,
        entryType: 'purchase',
      },
      {
        productId: 'product-1',
        quantity: 1,
        unitsPerCase: 5,
        entryType: 'return',
      },
    ]);

    expect(effects.get('product-1')).toBe(15);
  });

  it('applies only inventory deltas and writes movement history', async () => {
    const tx = {
      product: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'product-1',
          name: 'Test Product',
          currentQuantity: 20,
          allowNegativeInventory: false,
        }),
        update: jest.fn().mockResolvedValue({}),
      },
      inventoryLog: {
        create: jest.fn().mockResolvedValue({}),
      },
    };

    await service().applyInventoryDelta(
      tx,
      'store-1',
      'purchase-1',
      new Map([['product-1', 20]]),
      new Map([['product-1', 30]]),
      user,
    );

    expect(tx.product.update).toHaveBeenCalledWith({
      where: { id: 'product-1' },
      data: { currentQuantity: 30 },
    });
    expect(tx.inventoryLog.create).toHaveBeenCalledWith({
      data: {
        storeId: 'store-1',
        productId: 'product-1',
        performedByStaffId: 'staff-1',
        actionType: InventoryActionType.receive,
        quantityBefore: 20,
        quantityChanged: 10,
        quantityAfter: 30,
        reason: 'purchase_receipt',
        referenceType: 'purchase',
        referenceId: 'purchase-1',
      },
    });
  });
});
