import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { LoyaltyRedemptionMode, StaffRole } from '@prisma/client';
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
});
