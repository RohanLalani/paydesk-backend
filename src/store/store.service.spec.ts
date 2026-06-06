/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call */
import { BadRequestException } from '@nestjs/common';
import {
  BillingCycle,
  StaffRole,
  StoreBusinessType,
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
});

function createMockPrisma(): MockPrisma {
  const prisma = {
    subscription: {
      findFirst: jest.fn().mockResolvedValue({
        id: 'subscription-1',
        status: SubscriptionStatus.active,
        billingCycle: BillingCycle.monthly,
        maxStores: null,
      }),
      update: jest.fn(),
    },
    store: {
      count: jest.fn().mockResolvedValue(0),
      create: jest.fn().mockImplementation(({ data }) =>
        Promise.resolve(storeFixture(data)),
      ),
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
    update: jest.Mock;
  };
  $transaction: jest.Mock;
};
