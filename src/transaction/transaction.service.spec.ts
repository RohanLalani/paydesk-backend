/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return, @typescript-eslint/require-await */
import { BadRequestException } from '@nestjs/common';
import {
  CartStatus,
  PaymentMethod,
  PaymentStatus,
  Prisma,
  StaffRole,
  TaxStyle,
  TransactionStatus,
} from '@prisma/client';
import { PosAccessService } from '../common/pos-access.service';
import { PrismaService } from '../prisma.service';
import { RegistersService } from '../registers/registers.service';
import { TransactionService } from './transaction.service';

describe('TransactionService checkout', () => {
  let service: TransactionService;
  let prisma: MockPrisma;
  let access: { ensureStoreAccess: jest.Mock };
  let registers: { validateRegisterTokenForStore: jest.Mock };
  let state: TestState;

  const user = {
    accountId: 'manager-1',
    staffId: 'staff-1',
    role: StaffRole.manager,
    type: StaffRole.manager,
  };

  beforeEach(() => {
    state = createState();
    prisma = createMockPrisma(state);
    access = { ensureStoreAccess: jest.fn().mockResolvedValue(undefined) };
    registers = {
      validateRegisterTokenForStore: jest.fn().mockResolvedValue({
        register: {
          id: 'register-1',
          storeId: 'store-1',
        },
      }),
    };
    service = new TransactionService(
      prisma as unknown as PrismaService,
      access as unknown as PosAccessService,
      registers as unknown as RegistersService,
    );
  });

  it('checks out a ready cart into a completed paid transaction', async () => {
    const result = await service.checkout(
      { cartId: 'cart-1', paymentMethod: PaymentMethod.cash },
      user,
    );

    expect(access.ensureStoreAccess).toHaveBeenCalledWith(
      'store-1',
      user,
      'process_sales',
    );
    expect(result.transaction).toMatchObject({
      id: 'transaction-1',
      storeId: 'store-1',
      staffId: 'staff-1',
      customerId: 'customer-1',
      paymentMethod: PaymentMethod.cash,
      paymentStatus: PaymentStatus.paid,
      transactionStatus: TransactionStatus.completed,
      receiptNumber: expect.stringMatching(/^\d{8}-\d{6}$/),
    });
    expect(state.cart.status).toBe(CartStatus.completed);
  });

  it('stores the register id when checkout includes a register token', async () => {
    const result = await service.checkout(
      { cartId: 'cart-1', paymentMethod: PaymentMethod.cash },
      user,
      'reg_token',
    );

    expect(registers.validateRegisterTokenForStore).toHaveBeenCalledWith(
      'reg_token',
      'store-1',
    );
    expect(result.transaction.registerId).toBe('register-1');
    expect(state.transactions[0].registerId).toBe('register-1');
  });

  it('deducts inventory and creates sale inventory logs', async () => {
    await service.checkout(
      { cartId: 'cart-1', paymentMethod: PaymentMethod.card },
      user,
    );

    expect(state.product.currentQuantity).toBe(7);
    expect(state.inventoryLogs).toEqual([
      expect.objectContaining({
        actionType: 'sale',
        quantityBefore: 10,
        quantityChanged: -3,
        quantityAfter: 7,
        referenceType: 'transaction',
        referenceId: 'transaction-1',
      }),
    ]);
  });

  it('creates customer purchase history and recalculates customer tier', async () => {
    await service.checkout(
      { cartId: 'cart-1', paymentMethod: PaymentMethod.cash },
      user,
    );

    expect(state.purchaseHistory).toEqual([
      expect.objectContaining({
        customerId: 'customer-1',
        storeId: 'store-1',
        transactionId: 'transaction-1',
        totalSpend: expect.any(Prisma.Decimal),
      }),
    ]);
    expect(state.customerStore.tier).toBe('Gold');
    expect(state.customerStore.currentTierRuleId).toBe('tier-rule-1');
    expect(state.customerStore.currentTierId).toBe('tier-1');
  });

  it('generates and stores receipt JSON', async () => {
    const result = await service.checkout(
      { cartId: 'cart-1', paymentMethod: PaymentMethod.cash },
      user,
    );

    expect(state.receipts).toHaveLength(1);
    expect(result.receipt.receiptData).toMatchObject({
      transactionId: 'transaction-1',
      receiptNumber: result.transaction.receiptNumber,
      store: 'Main Store',
      cashier: 'Cashier One',
      customer: 'Ada Lovelace',
      subtotal: '6.00',
      discount: '2.10',
      tax: '0.54',
      total: '5.94',
      paymentMethod: PaymentMethod.cash,
    });
    expect(result.receipt.receiptData.items).toHaveLength(1);
  });

  it('rolls back transaction side effects when inventory becomes insufficient', async () => {
    state.product.currentQuantity = 2;

    await expect(
      service.checkout(
        { cartId: 'cart-1', paymentMethod: PaymentMethod.cash },
        user,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(state.transactions).toHaveLength(0);
    expect(state.receipts).toHaveLength(0);
    expect(state.inventoryLogs).toHaveLength(0);
    expect(state.purchaseHistory).toHaveLength(0);
    expect(state.product.currentQuantity).toBe(2);
    expect(state.cart.status).toBe(CartStatus.ready_for_payment);
  });
});

function createState(): TestState {
  const product = {
    id: 'product-1',
    barcode: '12345',
    name: 'Coffee',
    unitRetail: 2,
    currentQuantity: 10,
    trackInventory: true,
    allowNegativeInventory: false,
    allowEbt: true,
    taxStyle: TaxStyle.post_discount,
    isActive: true,
    tax: { rate: 0.1 },
  };
  const customer = {
    id: 'customer-1',
    customerNumber: 'C-1',
    firstName: 'Ada',
    lastName: 'Lovelace',
    phone: '4095551234',
  };

  return {
    product,
    cart: {
      id: 'cart-1',
      storeId: 'store-1',
      staffId: 'staff-1',
      customerId: 'customer-1',
      status: CartStatus.ready_for_payment,
      customer: {
        ...customer,
        stores: [
          {
            storeId: 'store-1',
            currentTier: {
              id: 'tier-1',
              name: 'Gold',
              discountModel: 'ORDER_PERCENTAGE',
              discountValue: new Prisma.Decimal(10),
              isActive: true,
            },
            currentTierRule: null,
          },
        ],
      },
      items: [
        {
          id: 'cart-item-1',
          productId: 'product-1',
          quantity: 3,
          originalUnitPrice: new Prisma.Decimal(2.5),
          unitPrice: new Prisma.Decimal(2),
          priceOverrideReason: 'Manager approved',
          product,
        },
      ],
    },
    store: {
      id: 'store-1',
      name: 'Main Store',
      address: '1 Main',
      ownerId: 'owner-1',
    },
    staff: { id: 'staff-1', name: 'Cashier One', role: StaffRole.manager },
    customer,
    customerStore: {
      id: 'customer-store-1',
      customerId: 'customer-1',
      storeId: 'store-1',
      tier: null,
      currentTierRuleId: null,
      currentTierId: null,
    },
    customerTierRule: {
      id: 'tier-rule-1',
      name: 'Gold',
      minimumSpend: new Prisma.Decimal(1),
      syncAcrossOwnerStores: false,
      tierId: 'tier-1',
      tier: { id: 'tier-1', name: 'Gold' },
    },
    transactions: [],
    receipts: [],
    inventoryLogs: [],
    purchaseHistory: [],
  };
}

function createMockPrisma(state: TestState): MockPrisma {
  const tx = {
    $executeRaw: jest.fn().mockResolvedValue([]),
    cart: {
      findUnique: jest.fn(async ({ where }) =>
        where.id === state.cart.id ? state.cart : null,
      ),
      update: jest.fn(async ({ data }) => {
        state.cart = { ...state.cart, ...data };
        return state.cart;
      }),
    },
    transaction: {
      count: jest.fn(async () => state.transactions.length),
      create: jest.fn(async ({ data }) => {
        const transaction = {
          id: `transaction-${state.transactions.length + 1}`,
          storeId: data.storeId,
          staffId: data.staffId,
          registerId: data.registerId ?? null,
          customerId: data.customerId,
          subtotal: data.subtotal,
          discountTotal: data.discountTotal,
          taxTotal: data.taxTotal,
          total: data.total,
          paymentMethod: data.paymentMethod,
          paymentStatus: data.paymentStatus,
          transactionStatus: data.transactionStatus,
          receiptNumber: data.receiptNumber,
          notes: data.notes ?? null,
          createdAt: new Date('2026-06-03T12:00:00.000Z'),
          updatedAt: new Date('2026-06-03T12:00:00.000Z'),
          store: state.store,
          staff: state.staff,
          register: data.registerId
            ? {
                id: data.registerId,
                name: 'Front Register 1',
                registerNumber: 'REG-001',
                status: 'active',
              }
            : null,
          customer: state.customer,
          items: data.items.create.map((item, index) => ({
            id: `transaction-item-${index + 1}`,
            transactionId: `transaction-${state.transactions.length + 1}`,
            createdAt: new Date('2026-06-03T12:00:00.000Z'),
            ...item,
          })),
          receipt: null,
        };

        state.transactions.push(transaction);

        return transaction;
      }),
      findUnique: jest.fn(),
    },
    product: {
      findUnique: jest.fn(async ({ where }) =>
        where.id === state.product.id ? state.product : null,
      ),
      updateMany: jest.fn(async ({ where, data }) => {
        if (where.id !== state.product.id) {
          return { count: 0 };
        }

        if (
          where.currentQuantity?.gte !== undefined &&
          state.product.currentQuantity < where.currentQuantity.gte
        ) {
          return { count: 0 };
        }

        state.product.currentQuantity -= data.currentQuantity.decrement;

        return { count: 1 };
      }),
    },
    inventoryLog: {
      create: jest.fn(async ({ data }) => {
        state.inventoryLogs.push(data as Record<string, any>);
        return data;
      }),
    },
    customerPurchaseHistory: {
      create: jest.fn(async ({ data }) => {
        state.purchaseHistory.push(
          data as { totalSpend: Prisma.Decimal; [key: string]: any },
        );
        return data;
      }),
      aggregate: jest.fn(async () => ({
        _sum: {
          totalSpend: state.purchaseHistory.reduce(
            (total, purchase) => total.plus(purchase.totalSpend),
            new Prisma.Decimal(0),
          ),
        },
      })),
    },
    store: {
      findUnique: jest.fn(async () => state.store),
    },
    customerStore: {
      findUnique: jest.fn(async () => state.customerStore),
      update: jest.fn(async ({ data }) => {
        state.customerStore = { ...state.customerStore, ...data };
        return state.customerStore;
      }),
      updateMany: jest.fn(),
    },
    customerTierRule: {
      findFirst: jest.fn(async ({ where }) =>
        where.syncAcrossOwnerStores ? null : state.customerTierRule,
      ),
    },
    customer: {
      update: jest.fn(async () => state.customer),
    },
    receipt: {
      create: jest.fn(async ({ data }) => {
        const receipt = {
          id: `receipt-${state.receipts.length + 1}`,
          transactionId: data.transactionId,
          receiptNumber: data.receiptNumber,
          receiptData: data.receiptData,
          createdAt: new Date('2026-06-03T12:00:00.000Z'),
        };

        state.receipts.push(receipt);

        return receipt;
      }),
      findUnique: jest.fn(),
    },
  };

  return {
    ...tx,
    $transaction: jest.fn(async (callback) => {
      const snapshot = cloneState(state);

      try {
        return await callback(tx);
      } catch (error) {
        Object.assign(state, snapshot);
        throw error;
      }
    }),
  };
}

function cloneState(state: TestState): TestState {
  return {
    ...state,
    product: { ...state.product },
    cart: {
      ...state.cart,
      customer: state.cart.customer
        ? {
            ...state.cart.customer,
            stores: state.cart.customer.stores.map((store) => ({
              ...store,
              currentTier: store.currentTier ? { ...store.currentTier } : null,
            })),
          }
        : null,
      items: state.cart.items.map((item) => ({
        ...item,
        product: { ...item.product },
      })),
    },
    customerStore: { ...state.customerStore },
    transactions: [...state.transactions],
    receipts: [...state.receipts],
    inventoryLogs: [...state.inventoryLogs],
    purchaseHistory: [...state.purchaseHistory],
  };
}

type TestState = {
  product: Record<string, any>;
  cart: Record<string, any>;
  store: Record<string, any>;
  staff: Record<string, any>;
  customer: Record<string, any>;
  customerStore: Record<string, any>;
  customerTierRule: Record<string, any>;
  transactions: Record<string, any>[];
  receipts: Record<string, any>[];
  inventoryLogs: Record<string, any>[];
  purchaseHistory: { totalSpend: Prisma.Decimal; [key: string]: any }[];
};

type MockPrisma = Record<string, any>;
