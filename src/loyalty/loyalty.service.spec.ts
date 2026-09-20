import { BadRequestException, ForbiddenException } from '@nestjs/common';
import {
  LoyaltyRedemptionMode,
  PunchCardRewardType,
  StaffRole,
  StoreServiceKey,
  StoreServiceStatus,
} from '@prisma/client';
import type { Mock } from 'jest-mock';
import { PosAccessService } from '../common/pos-access.service';
import { PrismaService } from '../prisma.service';
import { LoyaltyService } from './loyalty.service';

const user = {
  accountId: 'manager-1',
  staffId: 'staff-1',
  role: StaffRole.manager,
  type: StaffRole.manager,
};

const baseInput = {
  name: 'Sa Vapes Rewards',
  pointsEarned: 10,
  spendThresholdCents: 100,
  pointValueCents: 1,
};

function programFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: 'program-1',
    storeId: 'store-1',
    name: 'Sa Vapes Rewards',
    pointsEarned: 10,
    spendThresholdCents: 100,
    pointValueCents: 1,
    redemptionMode: LoyaltyRedemptionMode.PRODUCTS,
    cashbackStoreWide: false,
    isActive: true,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    eligibleProducts: [{ product: { id: 'product-1', name: 'Coffee' } }],
    ...overrides,
  };
}

type ProgramWriteArgs = {
  data: {
    redemptionMode: LoyaltyRedemptionMode;
    cashbackStoreWide: boolean;
    eligibleProducts: { create: Array<{ productId: string }> };
  };
};

function firstProgramWriteArgs(mock: Mock) {
  return mock.mock.calls[0][0] as ProgramWriteArgs;
}

describe('LoyaltyService points programs', () => {
  let service: LoyaltyService;
  let access: { ensureStoreAccess: jest.Mock };
  let prisma: {
    product: { count: jest.Mock };
    storeServiceSubscription: { findUnique: jest.Mock };
    loyaltyPointsProgram: {
      findMany: jest.Mock;
      findFirst: jest.Mock;
    };
    $transaction: jest.Mock;
  };
  let tx: {
    loyaltyPointsProgram: { create: jest.Mock; update: jest.Mock };
    loyaltyPointsProgramProduct: { deleteMany: jest.Mock };
  };

  beforeEach(() => {
    tx = {
      loyaltyPointsProgram: {
        create: jest.fn().mockResolvedValue(programFixture()),
        update: jest.fn().mockResolvedValue(programFixture()),
      },
      loyaltyPointsProgramProduct: {
        deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    prisma = {
      product: { count: jest.fn().mockResolvedValue(1) },
      storeServiceSubscription: {
        findUnique: jest.fn().mockResolvedValue({
          service: StoreServiceKey.loyalty,
          status: StoreServiceStatus.active,
        }),
      },
      loyaltyPointsProgram: {
        findMany: jest.fn().mockResolvedValue([]),
        findFirst: jest.fn().mockResolvedValue(programFixture()),
      },
      $transaction: jest.fn((callback: (transaction: typeof tx) => unknown) =>
        callback(tx),
      ),
    };
    access = {
      ensureStoreAccess: jest.fn().mockResolvedValue({ id: 'store-1' }),
    };
    service = new LoyaltyService(
      prisma as unknown as PrismaService,
      access as unknown as PosAccessService,
    );
  });

  it('creates PRODUCTS program with eligible items', async () => {
    await service.createPointsProgram(
      'store-1',
      {
        ...baseInput,
        redemptionMode: 'PRODUCTS',
        eligibleProductIds: ['product-1'],
      },
      user,
    );

    expect(access.ensureStoreAccess).toHaveBeenCalledWith(
      'store-1',
      user,
      'manage_customers',
    );
    expect(
      firstProgramWriteArgs(tx.loyaltyPointsProgram.create).data,
    ).toMatchObject({
      redemptionMode: LoyaltyRedemptionMode.PRODUCTS,
      cashbackStoreWide: false,
      eligibleProducts: { create: [{ productId: 'product-1' }] },
    });
  });

  it('rejects PRODUCTS with no eligible items', async () => {
    await expect(
      service.createPointsProgram(
        'store-1',
        { ...baseInput, redemptionMode: 'PRODUCTS' },
        user,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('creates CASHBACK store wide with no eligible items', async () => {
    await service.createPointsProgram(
      'store-1',
      { ...baseInput, redemptionMode: 'CASHBACK', cashbackStoreWide: true },
      user,
    );

    expect(
      firstProgramWriteArgs(tx.loyaltyPointsProgram.create).data,
    ).toMatchObject({
      redemptionMode: LoyaltyRedemptionMode.CASHBACK,
      cashbackStoreWide: true,
      eligibleProducts: { create: [] },
    });
  });

  it('rejects CASHBACK non-store-wide with no eligible items', async () => {
    await expect(
      service.createPointsProgram(
        'store-1',
        { ...baseInput, redemptionMode: 'CASHBACK', cashbackStoreWide: false },
        user,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('creates CASHBACK non-store-wide with eligible items', async () => {
    await service.createPointsProgram(
      'store-1',
      {
        ...baseInput,
        redemptionMode: 'CASHBACK',
        cashbackStoreWide: false,
        eligibleProductIds: ['product-1'],
      },
      user,
    );

    expect(tx.loyaltyPointsProgram.create).toHaveBeenCalled();
  });

  it('creates BOTH with eligible items', async () => {
    await service.createPointsProgram(
      'store-1',
      {
        ...baseInput,
        redemptionMode: 'BOTH',
        eligibleProductIds: ['product-1'],
      },
      user,
    );

    expect(
      firstProgramWriteArgs(tx.loyaltyPointsProgram.create).data,
    ).toMatchObject({
      redemptionMode: LoyaltyRedemptionMode.BOTH,
    });
  });

  it('rejects eligible product from another store', async () => {
    prisma.product.count.mockResolvedValueOnce(0);

    await expect(
      service.createPointsProgram(
        'store-1',
        {
          ...baseInput,
          redemptionMode: 'PRODUCTS',
          eligibleProductIds: ['other-store-product'],
        },
        user,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects invalid monetary and points values', async () => {
    await expect(
      service.createPointsProgram(
        'store-1',
        {
          ...baseInput,
          pointsEarned: 0,
          redemptionMode: 'CASHBACK',
          cashbackStoreWide: true,
        },
        user,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('GET returns eligible products', async () => {
    const result = await service.getPointsProgram('store-1', 'program-1', user);

    expect(result.eligibleProducts).toEqual([
      { id: 'product-1', name: 'Coffee' },
    ]);
  });

  it('PATCH replaces eligible product selection', async () => {
    await service.updatePointsProgram(
      'store-1',
      'program-1',
      {
        ...baseInput,
        redemptionMode: 'PRODUCTS',
        eligibleProductIds: ['product-2'],
      },
      user,
    );

    expect(tx.loyaltyPointsProgramProduct.deleteMany).toHaveBeenCalledWith({
      where: { programId: 'program-1' },
    });
    expect(
      firstProgramWriteArgs(tx.loyaltyPointsProgram.update).data
        .eligibleProducts,
    ).toEqual({
      create: [{ productId: 'product-2' }],
    });
  });

  it('rejects unauthorized store access', async () => {
    access.ensureStoreAccess.mockRejectedValueOnce(
      new ForbiddenException('no access'),
    );

    await expect(
      service.createPointsProgram(
        'store-1',
        { ...baseInput, redemptionMode: 'CASHBACK', cashbackStoreWide: true },
        user,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('rejects points program writes when loyalty is not active', async () => {
    prisma.storeServiceSubscription.findUnique.mockResolvedValueOnce({
      service: StoreServiceKey.loyalty,
      status: StoreServiceStatus.canceled,
    });

    await expect(
      service.createPointsProgram(
        'store-1',
        { ...baseInput, redemptionMode: 'CASHBACK', cashbackStoreWide: true },
        user,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(tx.loyaltyPointsProgram.create).not.toHaveBeenCalled();
  });
});

describe('LoyaltyService punch card programs', () => {
  let service: LoyaltyService;
  let access: { ensureStoreAccess: jest.Mock };
  let prisma: {
    product: { count: jest.Mock };
    department: { count: jest.Mock };
    storeServiceSubscription: { findUnique: jest.Mock };
    loyaltyPointsProgram: { findMany: jest.Mock; findFirst: jest.Mock };
    punchCardProgram: { findMany: jest.Mock; findFirst: jest.Mock };
    $transaction: jest.Mock;
  };
  let tx: {
    punchCardProgram: { create: jest.Mock; update: jest.Mock };
    punchCardProgramDepartment: { deleteMany: jest.Mock };
  };

  const percentageInput = {
    name: 'Coffee Punch Card',
    rewardType: 'PERCENTAGE_DISCOUNT',
    discountPercentage: 20,
    requiredTransactions: 10,
    minimumTransactionCents: 500,
    storeWide: true,
  };

  const departmentInput = {
    ...percentageInput,
    storeWide: false,
    eligibleDepartmentIds: ['department-1'],
  };

  function punchCardFixture(overrides: Record<string, unknown> = {}) {
    return {
      id: 'punch-1',
      storeId: 'store-1',
      name: 'Coffee Punch Card',
      rewardType: PunchCardRewardType.PERCENTAGE_DISCOUNT,
      discountPercentage: 20,
      freeProductId: null,
      requiredTransactions: 10,
      minimumTransactionCents: 500,
      storeWide: true,
      isActive: true,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      updatedAt: new Date('2026-01-01T00:00:00.000Z'),
      freeProduct: null,
      eligibleDepartments: [
        { department: { id: 'department-1', name: 'Coffee' } },
      ],
      ...overrides,
    };
  }

  beforeEach(() => {
    tx = {
      punchCardProgram: {
        create: jest.fn().mockResolvedValue(punchCardFixture()),
        update: jest.fn().mockResolvedValue(punchCardFixture()),
      },
      punchCardProgramDepartment: {
        deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    prisma = {
      product: { count: jest.fn().mockResolvedValue(1) },
      department: { count: jest.fn().mockResolvedValue(1) },
      storeServiceSubscription: {
        findUnique: jest.fn().mockResolvedValue({
          service: StoreServiceKey.loyalty,
          status: StoreServiceStatus.active,
        }),
      },
      loyaltyPointsProgram: {
        findMany: jest.fn().mockResolvedValue([]),
        findFirst: jest.fn().mockResolvedValue(programFixture()),
      },
      punchCardProgram: {
        findMany: jest.fn().mockResolvedValue([]),
        findFirst: jest.fn().mockResolvedValue(punchCardFixture()),
      },
      $transaction: jest.fn((callback: (transaction: typeof tx) => unknown) =>
        callback(tx),
      ),
    };
    access = {
      ensureStoreAccess: jest.fn().mockResolvedValue({ id: 'store-1' }),
    };
    service = new LoyaltyService(
      prisma as unknown as PrismaService,
      access as unknown as PosAccessService,
    );
  });

  function punchWriteArgs(mock: Mock) {
    return mock.mock.calls[0][0] as {
      data: {
        rewardType: PunchCardRewardType;
        discountPercentage: number | null;
        freeProductId: string | null;
        requiredTransactions: number;
        minimumTransactionCents: number;
        storeWide: boolean;
        eligibleDepartments: { create: Array<{ departmentId: string }> };
      };
    };
  }

  it('saves a percentage punch card program', async () => {
    await service.createPunchCardProgram('store-1', percentageInput, user);

    expect(punchWriteArgs(tx.punchCardProgram.create).data).toMatchObject({
      rewardType: PunchCardRewardType.PERCENTAGE_DISCOUNT,
      discountPercentage: 20,
      freeProductId: null,
      requiredTransactions: 10,
      minimumTransactionCents: 500,
      storeWide: true,
      eligibleDepartments: { create: [] },
    });
  });

  it('rejects zero percentage discounts', async () => {
    await expect(
      service.createPunchCardProgram(
        'store-1',
        { ...percentageInput, discountPercentage: 0 },
        user,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects percentage discounts above 100', async () => {
    await expect(
      service.createPunchCardProgram(
        'store-1',
        { ...percentageInput, discountPercentage: 101 },
        user,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects free product rewards without a product', async () => {
    await expect(
      service.createPunchCardProgram(
        'store-1',
        {
          ...percentageInput,
          rewardType: 'FREE_PRODUCT',
          discountPercentage: null,
        },
        user,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('saves a free product reward with a valid store product', async () => {
    await service.createPunchCardProgram(
      'store-1',
      {
        ...percentageInput,
        rewardType: 'FREE_PRODUCT',
        discountPercentage: null,
        freeProductId: 'product-1',
      },
      user,
    );

    expect(punchWriteArgs(tx.punchCardProgram.create).data).toMatchObject({
      rewardType: PunchCardRewardType.FREE_PRODUCT,
      discountPercentage: null,
      freeProductId: 'product-1',
    });
  });

  it('rejects free products from another store', async () => {
    prisma.product.count.mockResolvedValueOnce(0);

    await expect(
      service.createPunchCardProgram(
        'store-1',
        {
          ...percentageInput,
          rewardType: 'FREE_PRODUCT',
          discountPercentage: null,
          freeProductId: 'other-product',
        },
        user,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects zero required transactions', async () => {
    await expect(
      service.createPunchCardProgram(
        'store-1',
        { ...percentageInput, requiredTransactions: 0 },
        user,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects decimal required transactions', async () => {
    await expect(
      service.createPunchCardProgram(
        'store-1',
        { ...percentageInput, requiredTransactions: 1.5 },
        user,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('accepts a zero minimum transaction amount', async () => {
    await service.createPunchCardProgram(
      'store-1',
      { ...percentageInput, minimumTransactionCents: 0 },
      user,
    );

    expect(
      punchWriteArgs(tx.punchCardProgram.create).data.minimumTransactionCents,
    ).toBe(0);
  });

  it('does not require departments for store-wide programs', async () => {
    await service.createPunchCardProgram('store-1', percentageInput, user);

    expect(prisma.department.count).not.toHaveBeenCalled();
  });

  it('rejects non-store-wide programs with no departments', async () => {
    await expect(
      service.createPunchCardProgram(
        'store-1',
        { ...percentageInput, storeWide: false, eligibleDepartmentIds: [] },
        user,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('saves non-store-wide programs with valid departments', async () => {
    await service.createPunchCardProgram('store-1', departmentInput, user);

    expect(punchWriteArgs(tx.punchCardProgram.create).data).toMatchObject({
      storeWide: false,
      eligibleDepartments: { create: [{ departmentId: 'department-1' }] },
    });
  });

  it('rejects departments from another store', async () => {
    prisma.department.count.mockResolvedValueOnce(0);

    await expect(
      service.createPunchCardProgram('store-1', departmentInput, user),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects punch card reads when loyalty is not active', async () => {
    prisma.storeServiceSubscription.findUnique.mockResolvedValueOnce(null);

    await expect(
      service.getPunchCardProgram('store-1', 'punch-1', user),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.punchCardProgram.findFirst).not.toHaveBeenCalled();
  });

  it('GET returns the saved reward configuration', async () => {
    const result = await service.getPunchCardProgram(
      'store-1',
      'punch-1',
      user,
    );

    expect(result.discountPercentage).toBe(20);
    expect(result.eligibleDepartments).toEqual([
      { id: 'department-1', name: 'Coffee' },
    ]);
  });

  it('PATCH updates reward type and qualification rules', async () => {
    await service.updatePunchCardProgram(
      'store-1',
      'punch-1',
      {
        ...departmentInput,
        rewardType: 'FREE_PRODUCT',
        discountPercentage: null,
        freeProductId: 'product-1',
        requiredTransactions: 12,
        minimumTransactionCents: 1000,
      },
      user,
    );

    expect(tx.punchCardProgramDepartment.deleteMany).toHaveBeenCalledWith({
      where: { programId: 'punch-1' },
    });
    expect(punchWriteArgs(tx.punchCardProgram.update).data).toMatchObject({
      rewardType: PunchCardRewardType.FREE_PRODUCT,
      freeProductId: 'product-1',
      requiredTransactions: 12,
      minimumTransactionCents: 1000,
      storeWide: false,
      eligibleDepartments: { create: [{ departmentId: 'department-1' }] },
    });
  });
});
