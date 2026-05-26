/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/require-await */
import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { CustomerTierDiscountModel, Prisma, StaffRole } from '@prisma/client';
import { PrismaService } from '../prisma.service';
import { CustomerService } from './customer.service';

describe('CustomerService', () => {
  let service: CustomerService;
  let prisma: MockPrismaService;

  const ownerUser = {
    accountId: 'owner-1',
    staffId: 'staff-owner-1',
    role: 'owner',
    type: 'owner',
  };

  const staffUser = {
    accountId: 'manager-1',
    staffId: 'staff-manager-1',
    role: 'manager',
    type: 'manager',
  };

  const ownerStore = {
    id: 'store-1',
    ownerId: 'owner-1',
    name: 'Store 1',
    address: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
  };

  const otherStore = {
    ...ownerStore,
    id: 'store-2',
    ownerId: 'owner-2',
  };

  beforeEach(async () => {
    prisma = createMockPrisma();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CustomerService,
        {
          provide: PrismaService,
          useValue: prisma,
        },
      ],
    }).compile();

    service = module.get<CustomerService>(CustomerService);
  });

  it('creates a customer and links it to an accessible store', async () => {
    prisma.store.findUnique.mockResolvedValue(ownerStore);
    prisma.customer.findUnique.mockResolvedValue(null);
    prisma.customer.create.mockResolvedValue(
      customerFixture({ stores: [customerStoreFixture()] }),
    );

    const result = await service.create(
      {
        firstName: 'Ada',
        lastName: 'Lovelace',
        phone: '5551112222',
        email: 'ada@example.com',
        storeId: 'store-1',
      },
      ownerUser,
    );

    expect(prisma.customer.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          customerNumber: expect.stringMatching(/^\d{18}$/),
          firstName: 'Ada',
          lastName: 'Lovelace',
          phone: '5551112222',
          stores: { create: { storeId: 'store-1' } },
        }),
      }),
    );
    expect(result).toMatchObject({
      id: 'customer-1',
      customerNumber: '123456789012345678',
      stores: [{ storeId: 'store-1' }],
    });
  });

  it('rejects create when phone is already used', async () => {
    prisma.store.findUnique.mockResolvedValue(ownerStore);
    prisma.customer.findUnique.mockResolvedValue(null);
    prisma.customer.create.mockRejectedValue(uniqueError('phone'));

    await expect(
      service.create(
        {
          firstName: 'Ada',
          lastName: 'Lovelace',
          phone: '5551112222',
          storeId: 'store-1',
        },
        ownerUser,
      ),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('fetches a customer by customerNumber when the user can access one linked store', async () => {
    prisma.customer.findUnique.mockResolvedValue(
      customerFixture({
        stores: [
          customerStoreFixture(),
          customerStoreFixture({ storeId: 'store-2' }),
        ],
      }),
    );
    prisma.customerStore.findMany.mockResolvedValue([
      customerStoreFixture({ store: ownerStore }),
      customerStoreFixture({ storeId: 'store-2', store: otherStore }),
    ]);

    const result = await service.findByCustomerNumber(
      '123456789012345678',
      ownerUser,
    );

    expect(result.stores).toEqual([
      {
        storeId: 'store-1',
        tier: null,
        currentTier: null,
        currentTierRule: null,
      },
    ]);
  });

  it('throws a clear not found response when customerNumber does not exist', async () => {
    prisma.customer.findUnique.mockResolvedValue(null);

    await expect(
      service.findByCustomerNumber('123456789012345678', ownerUser),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('fetches a customer by phone', async () => {
    prisma.customer.findUnique.mockResolvedValue(
      customerFixture({ stores: [customerStoreFixture()] }),
    );
    prisma.customerStore.findMany.mockResolvedValue([
      customerStoreFixture({ store: ownerStore }),
    ]);

    const result = await service.findByPhone('5551112222', ownerUser);

    expect(prisma.customer.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { phone: '5551112222' } }),
    );
    expect(result.phone).toBe('5551112222');
  });

  it('lists customers for a store', async () => {
    prisma.store.findUnique.mockResolvedValue(ownerStore);
    prisma.customerStore.findMany.mockResolvedValue([
      customerStoreFixture({
        customer: customerFixture({ stores: [customerStoreFixture()] }),
      }),
    ]);

    const result = await service.listByStore('store-1', ownerUser);

    expect(result).toHaveLength(1);
    expect(result[0].stores).toEqual([
      {
        storeId: 'store-1',
        tier: null,
        currentTier: null,
        currentTierRule: null,
      },
    ]);
  });

  it('creates store tier definitions with discount models', async () => {
    prisma.store.findUnique.mockResolvedValue(ownerStore);
    prisma.customerTier.create.mockResolvedValue(tierFixture());

    const result = await service.createTier(
      {
        storeId: 'store-1',
        name: 'Gold',
        discountModel: CustomerTierDiscountModel.ORDER_PERCENTAGE,
        discountValue: 10,
      },
      ownerUser,
    );

    expect(prisma.customerTier.create).toHaveBeenCalledWith({
      data: {
        name: 'Gold',
        discountModel: CustomerTierDiscountModel.ORDER_PERCENTAGE,
        discountValue: new Prisma.Decimal(10),
        ownerId: 'owner-1',
        storeId: 'store-1',
      },
    });
    expect(result).toMatchObject({
      name: 'Gold',
      discountModel: CustomerTierDiscountModel.ORDER_PERCENTAGE,
      discountValue: '10',
    });
  });

  it('updates customer profile fields', async () => {
    prisma.customerStore.findMany.mockResolvedValue([
      customerStoreFixture({ store: ownerStore }),
    ]);
    prisma.customer.update.mockResolvedValue(
      customerFixture({ firstName: 'Grace', stores: [customerStoreFixture()] }),
    );

    const result = await service.update(
      'customer-1',
      { firstName: 'Grace', email: null },
      ownerUser,
    );

    expect(prisma.customer.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'customer-1' },
        data: { firstName: 'Grace', email: null },
      }),
    );
    expect(result.firstName).toBe('Grace');
  });

  it('returns the existing customer on an empty update body', async () => {
    prisma.customerStore.findMany.mockResolvedValue([
      customerStoreFixture({ store: ownerStore }),
    ]);
    prisma.customer.findUnique.mockResolvedValue(
      customerFixture({ stores: [customerStoreFixture()] }),
    );

    const result = await service.update('customer-1', {}, ownerUser);

    expect(prisma.customer.update).not.toHaveBeenCalled();
    expect(result.id).toBe('customer-1');
  });

  it('creates owner-owned tier rules without trusting ownerId from the client', async () => {
    prisma.store.findUnique.mockResolvedValue(ownerStore);
    prisma.customerTier.findFirst.mockResolvedValue(tierFixture());
    prisma.customerTierRule.create.mockResolvedValue(
      tierRuleFixture({ tierId: 'tier-1', tier: tierFixture() }),
    );

    const result = await service.createTierRule(
      {
        storeId: 'store-1',
        tierId: 'tier-1',
        minimumSpend: 500,
        syncAcrossOwnerStores: true,
        ownerId: 'malicious-owner',
      },
      ownerUser,
    );

    expect(prisma.customerTierRule.create).toHaveBeenCalledWith({
      data: {
        name: 'Gold',
        minimumSpend: new Prisma.Decimal(500),
        syncAcrossOwnerStores: true,
        ownerId: 'owner-1',
        storeId: 'store-1',
        tierId: 'tier-1',
      },
      include: {
        tier: true,
      },
    });
    expect(result).toMatchObject({
      ownerId: 'owner-1',
      name: 'Gold',
      tier: {
        id: 'tier-1',
        discountModel: CustomerTierDiscountModel.ORDER_PERCENTAGE,
      },
    });
  });

  it('blocks non-owner users from creating tier rules', async () => {
    prisma.store.findUnique.mockResolvedValue(ownerStore);
    prisma.storeStaff.findUnique.mockResolvedValue({
      id: 'store-staff-1',
      storeId: 'store-1',
      staffId: 'staff-manager-1',
      role: StaffRole.manager,
    });

    await expect(
      service.createTierRule(
        { storeId: 'store-1', name: 'Gold', minimumSpend: 500 },
        staffUser,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('returns only accessible purchases from the last 60 days', async () => {
    prisma.customerStore.findMany.mockResolvedValue([
      customerStoreFixture({ store: ownerStore }),
    ]);
    prisma.customerPurchaseHistory.findMany.mockResolvedValue([
      purchaseFixture(),
    ]);

    const result = await service.getPurchases('customer-1', ownerUser);

    expect(prisma.customerPurchaseHistory.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          customerId: 'customer-1',
          storeId: { in: ['store-1'] },
          purchasedAt: { gte: expect.any(Date) },
        }),
      }),
    );
    expect(result).toEqual([
      {
        id: 'purchase-1',
        storeId: 'store-1',
        transactionId: 'transaction-1',
        totalSpend: '100',
        purchasedAt: new Date('2026-01-15T00:00:00.000Z'),
      },
    ]);
  });

  it('recalculates a store-specific customer tier', async () => {
    prisma.customerStore.findMany
      .mockResolvedValueOnce([customerStoreFixture({ store: ownerStore })])
      .mockResolvedValueOnce([customerStoreFixture({ store: ownerStore })]);
    prisma.store.findUnique.mockResolvedValue(ownerStore);
    prisma.customerPurchaseHistory.aggregate
      .mockResolvedValueOnce({ _sum: { totalSpend: new Prisma.Decimal(600) } })
      .mockResolvedValueOnce({ _sum: { totalSpend: new Prisma.Decimal(600) } });
    prisma.customerTierRule.findFirst
      .mockResolvedValueOnce(tierRuleFixture({ syncAcrossOwnerStores: false }))
      .mockResolvedValueOnce(null);
    prisma.$transaction.mockImplementation(async (callback) =>
      callback({
        customerStore: {
          update: prisma.customerStore.update,
          updateMany: prisma.customerStore.updateMany,
        },
        customer: { update: prisma.customer.update },
      }),
    );
    prisma.customer.update.mockResolvedValue(
      customerFixture({
        stores: [
          customerStoreFixture({
            tier: 'Gold',
            currentTierRule: tierRuleFixture({ syncAcrossOwnerStores: false }),
          }),
        ],
      }),
    );

    const result = await service.recalculateCustomerTier(
      'customer-1',
      { storeId: 'store-1' },
      ownerUser,
    );

    expect(prisma.customerStore.update).toHaveBeenCalledWith({
      where: { id: 'customer-store-1' },
      data: {
        tier: 'Gold',
        currentTierRuleId: 'tier-rule-1',
        currentTierId: null,
      },
    });
    expect(result.stores[0].tier).toBe('Gold');
  });

  it('recalculates an owner-synced tier across owner stores', async () => {
    prisma.customerStore.findMany
      .mockResolvedValueOnce([customerStoreFixture({ store: ownerStore })])
      .mockResolvedValueOnce([customerStoreFixture({ store: ownerStore })]);
    prisma.store.findUnique.mockResolvedValue(ownerStore);
    prisma.customerPurchaseHistory.aggregate
      .mockResolvedValueOnce({ _sum: { totalSpend: new Prisma.Decimal(200) } })
      .mockResolvedValueOnce({ _sum: { totalSpend: new Prisma.Decimal(800) } });
    prisma.customerTierRule.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(tierRuleFixture({ syncAcrossOwnerStores: true }));
    prisma.$transaction.mockImplementation(async (callback) =>
      callback({
        customerStore: {
          update: prisma.customerStore.update,
          updateMany: prisma.customerStore.updateMany,
        },
        customer: { update: prisma.customer.update },
      }),
    );
    prisma.customer.update.mockResolvedValue(
      customerFixture({
        tier: 'Gold',
        stores: [
          customerStoreFixture({
            tier: 'Gold',
            currentTierRule: tierRuleFixture({ syncAcrossOwnerStores: true }),
          }),
        ],
      }),
    );

    const result = await service.recalculateCustomerTier(
      'customer-1',
      { storeId: 'store-1' },
      ownerUser,
    );

    expect(prisma.customerStore.updateMany).toHaveBeenCalledWith({
      where: {
        customerId: 'customer-1',
        store: { ownerId: 'owner-1' },
      },
      data: {
        tier: 'Gold',
        currentTierRuleId: 'tier-rule-1',
        currentTierId: null,
      },
    });
    expect(result.tier).toBe('Gold');
  });

  it('exposes a weekly tier recalculation placeholder', () => {
    expect(service.recalculateWeeklyCustomerTiers()).toEqual({
      message:
        'Weekly customer tier recalculation placeholder. Wire this method to a scheduler when automation is added.',
    });
  });
});

function createMockPrisma() {
  return {
    store: {
      findUnique: jest.fn(),
    },
    storeStaff: {
      findUnique: jest.fn(),
    },
    customerTier: {
      create: jest.fn(),
      findFirst: jest.fn(),
    },
    customer: {
      create: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn(),
    },
    customerStore: {
      findMany: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
    customerTierRule: {
      create: jest.fn(),
      findFirst: jest.fn(),
    },
    customerPurchaseHistory: {
      findMany: jest.fn(),
      aggregate: jest.fn(),
    },
    $transaction: jest.fn(),
  };
}

function customerFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: 'customer-1',
    customerNumber: '123456789012345678',
    email: 'ada@example.com',
    firstName: 'Ada',
    lastName: 'Lovelace',
    phone: '5551112222',
    rewardPoints: 0,
    tier: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    stores: [],
    ...overrides,
  };
}

function customerStoreFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: 'customer-store-1',
    customerId: 'customer-1',
    storeId: 'store-1',
    tier: null,
    currentTierId: null,
    currentTier: null,
    currentTierRuleId: null,
    currentTierRule: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    store: {
      id: 'store-1',
      ownerId: 'owner-1',
    },
    ...overrides,
  };
}

function tierFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: 'tier-1',
    name: 'Gold',
    discountModel: CustomerTierDiscountModel.ORDER_PERCENTAGE,
    discountValue: new Prisma.Decimal(10),
    isActive: true,
    ownerId: 'owner-1',
    storeId: 'store-1',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

function tierRuleFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: 'tier-rule-1',
    name: 'Gold',
    minimumSpend: new Prisma.Decimal(500),
    syncAcrossOwnerStores: true,
    isActive: true,
    ownerId: 'owner-1',
    storeId: 'store-1',
    tierId: null,
    tier: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

function purchaseFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: 'purchase-1',
    customerId: 'customer-1',
    storeId: 'store-1',
    transactionId: 'transaction-1',
    totalSpend: new Prisma.Decimal(100),
    purchasedAt: new Date('2026-01-15T00:00:00.000Z'),
    createdAt: new Date('2026-01-15T00:00:00.000Z'),
    ...overrides,
  };
}

function uniqueError(field: string) {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: '5.22.0',
    meta: { target: [field] },
  });
}

type MockPrismaService = ReturnType<typeof createMockPrisma>;
