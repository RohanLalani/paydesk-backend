/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return, @typescript-eslint/require-await */
import { BadRequestException } from '@nestjs/common';
import { CartStatus, Prisma, StaffRole, TaxStyle } from '@prisma/client';
import { PosAccessService } from '../common/pos-access.service';
import { PrismaService } from '../prisma.service';
import { CartService } from './cart.service';

describe('CartService race safety', () => {
  let service: CartService;
  let prisma: MockPrismaService;
  let access: MockPosAccessService;
  let tx: MockTransactionClient;
  let state: TestState;

  const user = {
    accountId: 'manager-1',
    staffId: 'staff-1',
    role: StaffRole.manager,
    type: StaffRole.manager,
  };

  beforeEach(() => {
    state = createState();
    tx = createMockTransaction(state);
    prisma = {
      ...tx,
      $transaction: jest.fn(async (callback) => callback(tx)),
    };
    access = {
      ensureStoreAccess: jest.fn().mockResolvedValue(undefined),
    };
    service = new CartService(
      prisma as unknown as PrismaService,
      access as unknown as PosAccessService,
    );
  });

  it('serializes duplicate barcode scans and safely increments an existing item', async () => {
    state.cart.items = [
      cartItemFixture({
        id: 'item-1',
        quantity: 1,
        product: state.product,
      }),
    ];

    const result = await service.addBarcode(
      'cart-1',
      { storeId: 'store-1', barcode: '12345', quantity: 2 },
      user,
    );

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(tx.$executeRaw).toHaveBeenCalledWith(
      expect.arrayContaining([expect.stringContaining('FROM "Cart"')]),
      'cart-1',
    );
    expect(tx.$executeRaw).toHaveBeenCalledWith(
      expect.arrayContaining([expect.stringContaining('FROM "Product"')]),
      'product-1',
    );
    expect(tx.cartItem.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'item-1',
        quantity: { lte: 8 },
      },
      data: {
        quantity: { increment: 2 },
      },
    });
    expect(result.items[0]).toMatchObject({ id: 'item-1', quantity: 3 });
  });

  it('retries when a simultaneous first scan creates the same cart item', async () => {
    const uniqueError = new Prisma.PrismaClientKnownRequestError(
      'Unique constraint failed on the fields: (`cartId`,`productId`)',
      {
        code: 'P2002',
        clientVersion: 'test',
      },
    );
    let firstAttempt = true;

    tx.cartItem.create.mockImplementation(async () => {
      if (firstAttempt) {
        firstAttempt = false;
        state.cart.items = [
          cartItemFixture({
            id: 'item-1',
            quantity: 1,
            product: state.product,
          }),
        ];
        throw uniqueError;
      }

      throw new Error('create should not be called after retry sees item');
    });

    const result = await service.addBarcode(
      'cart-1',
      { storeId: 'store-1', barcode: '12345', quantity: 1 },
      user,
    );

    expect(prisma.$transaction).toHaveBeenCalledTimes(2);
    expect(tx.cartItem.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'item-1',
        quantity: { lte: 9 },
      },
      data: {
        quantity: { increment: 1 },
      },
    });
    expect(result.items[0]).toMatchObject({ id: 'item-1', quantity: 2 });
  });

  it('rejects quantity updates when inventory was reduced after the cart was opened', async () => {
    state.cart.items = [
      cartItemFixture({
        id: 'item-1',
        quantity: 1,
        product: { ...state.product, currentQuantity: 10 },
      }),
    ];
    state.product.currentQuantity = 1;

    await expect(
      service.updateQuantity('cart-1', 'item-1', { quantity: 2 }, user),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(tx.cartItem.update).not.toHaveBeenCalled();
    expect(tx.$executeRaw).toHaveBeenCalledWith(
      expect.arrayContaining([expect.stringContaining('FROM "Product"')]),
      'product-1',
    );
  });

  it('revalidates fresh inventory before preparing payment', async () => {
    state.cart.items = [
      cartItemFixture({
        id: 'item-1',
        quantity: 3,
        product: { ...state.product, currentQuantity: 10 },
      }),
    ];
    state.product.currentQuantity = 2;

    await expect(service.preparePayment('cart-1', user)).rejects.toBeInstanceOf(
      BadRequestException,
    );

    expect(tx.cart.update).not.toHaveBeenCalled();
  });

  it('serializes concurrent price overrides and returns the committed item state', async () => {
    state.cart.items = [
      cartItemFixture({
        id: 'item-1',
        quantity: 1,
        product: state.product,
      }),
    ];

    const [first, second] = await Promise.all([
      service.priceOverride(
        'cart-1',
        'item-1',
        { price: 2.49, reason: 'First manager' },
        user,
      ),
      service.priceOverride(
        'cart-1',
        'item-1',
        { price: 1.99, reason: 'Second manager' },
        user,
      ),
    ]);

    expect(prisma.$transaction).toHaveBeenCalledTimes(2);
    expect(tx.$executeRaw).toHaveBeenCalledWith(
      expect.arrayContaining([expect.stringContaining('FROM "CartItem"')]),
      'item-1',
    );
    expect(tx.cartItem.update).toHaveBeenCalledTimes(2);
    expect([
      first.items[0].priceOverrideReason,
      second.items[0].priceOverrideReason,
    ]).toEqual(expect.arrayContaining(['Second manager']));
    expect(second.items[0].priceOverrideReason).toBe('Second manager');
    expect(state.cart.items[0].unitPrice.toFixed(2)).toBe('1.99');
  });
});

function createState(): TestState {
  const product = productFixture();
  const cart = cartFixture({ items: [] });

  return {
    product,
    cart,
  };
}

function createMockTransaction(state: TestState): MockTransactionClient {
  return {
    $executeRaw: jest.fn().mockResolvedValue([]),
    cart: {
      findUnique: jest.fn(async ({ where }) =>
        where.id === state.cart.id ? state.cart : null,
      ),
      update: jest.fn(async ({ where, data }) => {
        if (where.id !== state.cart.id) {
          return null;
        }

        state.cart = {
          ...state.cart,
          ...data,
        };

        return state.cart;
      }),
    },
    cartItem: {
      create: jest.fn(async ({ data }) => {
        const item = cartItemFixture({
          id: 'item-1',
          quantity: data.quantity,
          product: state.product,
          originalUnitPrice: data.originalUnitPrice,
          unitPrice: data.unitPrice,
        });

        state.cart.items = [...state.cart.items, item];

        return item;
      }),
      update: jest.fn(async ({ where, data }) => {
        state.cart.items = state.cart.items.map((item) =>
          item.id === where.id
            ? {
                ...item,
                ...data,
              }
            : item,
        );

        return state.cart.items.find((item) => item.id === where.id);
      }),
      updateMany: jest.fn(async ({ where, data }) => {
        const item = state.cart.items.find(
          (cartItem) => cartItem.id === where.id,
        );
        const maxQuantity = where.quantity?.lte;

        if (
          !item ||
          (maxQuantity !== undefined && item.quantity > maxQuantity)
        ) {
          return { count: 0 };
        }

        item.quantity += data.quantity.increment;

        return { count: 1 };
      }),
    },
    product: {
      findFirst: jest.fn(async ({ where }) => {
        if (
          where.storeId === state.cart.storeId &&
          where.barcode === state.product.barcode &&
          where.isActive === state.product.isActive
        ) {
          return { id: state.product.id };
        }

        return null;
      }),
      findUnique: jest.fn(async ({ where }) =>
        where.id === state.product.id ? state.product : null,
      ),
    },
    customer: {
      findUnique: jest.fn(),
    },
  };
}

function cartFixture(overrides: Partial<TestCart> = {}): TestCart {
  return {
    id: 'cart-1',
    storeId: 'store-1',
    staffId: 'staff-1',
    customerId: null,
    status: CartStatus.active,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    customer: null,
    items: [],
    ...overrides,
  };
}

function cartItemFixture(overrides: Partial<TestCartItem> = {}): TestCartItem {
  const product = overrides.product ?? productFixture();

  return {
    id: 'item-1',
    cartId: 'cart-1',
    productId: product.id,
    quantity: 1,
    originalUnitPrice: new Prisma.Decimal(product.unitRetail),
    unitPrice: new Prisma.Decimal(product.unitRetail),
    priceOverrideReason: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    product,
    ...overrides,
  };
}

function productFixture(overrides: Partial<TestProduct> = {}): TestProduct {
  return {
    id: 'product-1',
    barcode: '12345',
    name: 'Test Product',
    saleType: 'piece',
    currentQuantity: 10,
    unitsPerCase: null,
    caseCost: null,
    caseDiscount: 0,
    discountPerUnit: null,
    caseRebate: 0,
    rebatePerUnit: null,
    unitCost: null,
    unitCostAfterDiscountAndRebate: null,
    unitRetail: 3.99,
    onlineRetailPrice: null,
    unitOfMeasure: null,
    size: null,
    margin: null,
    defaultMargin: null,
    maxInventory: null,
    minInventory: null,
    minimumAge: null,
    nacsCode: null,
    nacsCategory: null,
    nacsSubCategory: null,
    blueLaw: false,
    linkedItems: null,
    kitchenPrint: false,
    allowEbt: false,
    trackInventory: true,
    allowNegativeInventory: false,
    taxStyle: TaxStyle.post_discount,
    isActive: true,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    storeId: 'store-1',
    departmentId: 'department-1',
    priceGroupId: 'price-group-1',
    productCategoryId: 'category-1',
    taxId: 'tax-1',
    tax: {
      id: 'tax-1',
      name: 'Sales Tax',
      rate: 0.0825,
      isActive: true,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      updatedAt: new Date('2026-01-01T00:00:00.000Z'),
      storeId: 'store-1',
    },
    ...overrides,
  };
}

type TestProduct = Prisma.ProductGetPayload<{
  include: {
    tax: true;
  };
}>;

type TestCartItem = Prisma.CartItemGetPayload<{
  include: {
    product: {
      include: {
        tax: true;
      };
    };
  };
}>;

type TestCart = Prisma.CartGetPayload<{
  include: {
    customer: {
      include: {
        stores: {
          include: {
            currentTier: true;
            currentTierRule: true;
          };
        };
      };
    };
    items: {
      include: {
        product: {
          include: {
            tax: true;
          };
        };
      };
    };
  };
}>;

type TestState = {
  product: TestProduct;
  cart: TestCart;
};

type MockTransactionClient = {
  $executeRaw: jest.Mock;
  cart: {
    findUnique: jest.Mock;
    update: jest.Mock;
  };
  cartItem: {
    create: jest.Mock;
    update: jest.Mock;
    updateMany: jest.Mock;
  };
  product: {
    findFirst: jest.Mock;
    findUnique: jest.Mock;
  };
  customer: {
    findUnique: jest.Mock;
  };
};

type MockPrismaService = MockTransactionClient & {
  $transaction: jest.Mock;
};

type MockPosAccessService = {
  ensureStoreAccess: jest.Mock;
};
