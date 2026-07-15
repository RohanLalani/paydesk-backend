/* eslint-disable @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return */
import { BadRequestException } from '@nestjs/common';
import {
  BillingCycle,
  StaffRole,
  StoreBusinessType,
  SubscriptionPlan,
  SubscriptionStatus,
} from '@prisma/client';
import { PosAccessService } from '../common/pos-access.service';
import { PrismaService } from '../prisma.service';
import { StoreService } from './store.service';

describe('StoreService businessType', () => {
  let service: StoreService;
  let prisma: MockPrisma;
  let access: { ensureStoreAccess: jest.Mock };

  const ownerUser = {
    accountId: 'owner-1',
    staffId: 'staff-owner-1',
    role: StaffRole.owner,
    type: StaffRole.owner,
  };

  beforeEach(() => {
    prisma = createMockPrisma();
    access = {
      ensureStoreAccess: jest.fn().mockResolvedValue(storeFixture()),
    };
    service = new StoreService(
      prisma as unknown as PrismaService,
      access as unknown as PosAccessService,
    );
  });

  it('requires businessType when creating a store', async () => {
    await expect(
      service.create({ name: 'Downtown Store' }, ownerUser),
    ).rejects.toThrow(new BadRequestException('businessType is required'));
  });

  it('rejects invalid businessType values', async () => {
    await expect(
      service.create(
        { name: 'Downtown Store', businessType: 'restaurant' },
        ownerUser,
      ),
    ).rejects.toThrow(
      new BadRequestException(
        'businessType must be a valid store business type',
      ),
    );
  });

  it('stores businessType on create responses', async () => {
    const result = await service.create(
      {
        name: 'Downtown Store',
        address: '123 Main Street',
        businessType: StoreBusinessType.convenience_store,
      },
      ownerUser,
    );

    expect(prisma.store.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          name: 'Downtown Store',
          address: '123 Main Street',
          businessType: StoreBusinessType.convenience_store,
          ownerId: 'owner-1',
          isActive: false,
        }),
      }),
    );
    expect(result.businessType).toBe(StoreBusinessType.convenience_store);
  });

  it('allows businessType updates', async () => {
    prisma.store.update.mockResolvedValue(
      storeFixture({ businessType: StoreBusinessType.grocery_store }),
    );

    const result = await service.update(
      'store-1',
      { businessType: StoreBusinessType.grocery_store },
      ownerUser,
    );

    expect(access.ensureStoreAccess).toHaveBeenCalledWith(
      'store-1',
      ownerUser,
      'edit_store',
    );
    expect(prisma.store.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'store-1' },
        data: { businessType: StoreBusinessType.grocery_store },
      }),
    );
    expect(result.businessType).toBe(StoreBusinessType.grocery_store);
  });

  it.each([
    [SubscriptionPlan.plus, 1, 50, 50, 600],
    [SubscriptionPlan.plus, 2, 50, 100, 1200],
    [SubscriptionPlan.plus, 7, 50, 350, 4200],
    [SubscriptionPlan.advanced, 1, 80, 80, 960],
    [SubscriptionPlan.advanced, 2, 80, 160, 1920],
    [SubscriptionPlan.advanced, 7, 80, 560, 6720],
  ])(
    'calculates %s monthly billing for %i active stores',
    (plan, activeStoreCount, pricePerStore, monthlyTotal, annualTotal) => {
      expect(service.calculateStorePricing(activeStoreCount, plan)).toEqual({
        activeStoreCount,
        pricePerStore,
        totalMonthlyAmount: monthlyTotal,
        totalAnnualAmount: annualTotal,
      });
    },
  );

  it('calculates annual billing from monthly plan price', () => {
    expect(service.calculateStorePricing(3, SubscriptionPlan.advanced)).toEqual(
      {
        activeStoreCount: 3,
        pricePerStore: 80,
        totalMonthlyAmount: 240,
        totalAnnualAmount: 2880,
      },
    );
  });

  it('creates stores as inactive drafts without recalculating billing', async () => {
    prisma.subscription.findFirst.mockResolvedValue(null);

    await service.create(
      {
        name: 'Downtown Store',
        businessType: StoreBusinessType.convenience_store,
      },
      ownerUser,
    );

    expect(prisma.store.create).toHaveBeenCalledWith({
      data: {
        name: 'Downtown Store',
        address: null,
        businessType: StoreBusinessType.convenience_store,
        ownerId: 'owner-1',
        isActive: false,
        features: {
          create: [
            {
              feature: 'lottery',
              enabled: false,
              source: 'setup',
            },
            {
              feature: 'recipe_suite',
              enabled: false,
              source: 'setup',
            },
          ],
        },
      },
      include: expect.any(Object),
    });
    expect(prisma.subscription.findFirst).not.toHaveBeenCalled();
    expect(prisma.subscription.update).not.toHaveBeenCalled();
  });

  it('activates a draft store and recalculates subscription totals', async () => {
    prisma.store.findUnique.mockResolvedValue(
      storeFixture({ isActive: false }),
    );
    prisma.store.count.mockResolvedValueOnce(0).mockResolvedValueOnce(1);
    prisma.store.update.mockResolvedValue(storeFixture({ isActive: true }));

    const result = await service.activateStore('store-1', ownerUser);

    expect(prisma.store.update).toHaveBeenCalledWith({
      where: { id: 'store-1' },
      data: { isActive: true },
      include: expect.any(Object),
    });
    expect(prisma.subscription.update).toHaveBeenCalledWith({
      where: { id: 'subscription-1' },
      data: {
        activeStoreCount: 1,
        pricePerStore: 50,
        totalMonthlyAmount: 50,
        totalAnnualAmount: 600,
      },
    });
    expect(result.isActive).toBe(true);
  });

  it('recalculates subscription totals when deleting a store', async () => {
    prisma.store.count.mockResolvedValue(2);
    prisma.store.update.mockResolvedValue(storeFixture({ isActive: false }));

    await service.remove('store-1', ownerUser);

    expect(prisma.store.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'store-1' },
        data: { isActive: false },
      }),
    );
    expect(prisma.subscription.update).toHaveBeenCalledWith({
      where: { id: 'subscription-1' },
      data: {
        activeStoreCount: 2,
        pricePerStore: 50,
        totalMonthlyAmount: 100,
        totalAnnualAmount: 1200,
      },
    });
  });

  it('changing plan recalculates subscription totals', async () => {
    prisma.store.count.mockResolvedValue(3);

    await service.updateSubscriptionPlan(
      { plan: SubscriptionPlan.advanced },
      ownerUser,
    );

    expect(prisma.subscription.update).toHaveBeenCalledWith({
      where: { id: 'subscription-1' },
      data: {
        plan: SubscriptionPlan.advanced,
        activeStoreCount: 3,
        pricePerStore: 80,
        totalMonthlyAmount: 240,
        totalAnnualAmount: 2880,
      },
      include: { addons: true },
    });
  });
});

function createMockPrisma(): MockPrisma {
  const prisma = {
    subscription: {
      findFirst: jest.fn().mockResolvedValue({
        id: 'subscription-1',
        status: SubscriptionStatus.active,
        plan: SubscriptionPlan.plus,
        billingCycle: BillingCycle.monthly,
        maxStores: null,
      }),
      update: jest.fn().mockImplementation(({ data }) =>
        Promise.resolve({
          id: 'subscription-1',
          status: SubscriptionStatus.active,
          plan: data.plan ?? SubscriptionPlan.plus,
          billingCycle: BillingCycle.monthly,
          maxStores: null,
          addons: [],
          ...data,
        }),
      ),
    },
    store: {
      count: jest.fn().mockResolvedValue(0),
      create: jest
        .fn()
        .mockImplementation(({ data }) => Promise.resolve(storeFixture(data))),
      findUnique: jest
        .fn()
        .mockImplementation(() => Promise.resolve(storeFixture())),
      update: jest.fn(),
    },
    $transaction: jest.fn((callback) => callback(prisma)),
  };

  return prisma;
}

function storeFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: 'store-1',
    name: 'Downtown Store',
    address: null,
    businessType: StoreBusinessType.other,
    isActive: true,
    ownerId: 'owner-1',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    departments: [],
    priceGroups: [],
    productCategories: [],
    taxes: [],
    products: [],
    staff: [],
    ...overrides,
  };
}

type MockPrisma = {
  subscription: {
    findFirst: jest.Mock;
    update: jest.Mock;
  };
  store: {
    count: jest.Mock;
    create: jest.Mock;
    findUnique: jest.Mock;
    update: jest.Mock;
  };
  $transaction: jest.Mock;
};
