import { ForbiddenException } from '@nestjs/common';
import { StaffRole } from '@prisma/client';
import { PosAccessService } from '../common/pos-access.service';
import { PrismaService } from '../prisma.service';
import { ProductService } from './product.service';

describe('ProductService permissions', () => {
  let service: ProductService;
  let prisma: { $transaction: jest.Mock };
  let access: { ensureStoreAccess: jest.Mock };

  const user = {
    accountId: 'manager-1',
    staffId: 'staff-manager-1',
    role: StaffRole.manager,
    type: StaffRole.manager,
  };

  beforeEach(() => {
    prisma = {
      $transaction: jest.fn(),
    };
    access = {
      ensureStoreAccess: jest.fn().mockResolvedValue(undefined),
    };
    service = new ProductService(
      prisma as unknown as PrismaService,
      access as unknown as PosAccessService,
    );
  });

  it('requires manage_inventory for receiving inventory', async () => {
    access.ensureStoreAccess.mockRejectedValueOnce(
      new ForbiddenException('no inventory permission'),
    );

    await expect(
      service.receiveInventory(
        {
          storeId: 'store-1',
          items: [{ productId: 'product-1', quantity: 1 }],
        },
        user,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);

    expect(access.ensureStoreAccess).toHaveBeenCalledWith(
      'store-1',
      user,
      'manage_inventory',
    );
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('requires manage_inventory for adjusting inventory', async () => {
    access.ensureStoreAccess.mockRejectedValueOnce(
      new ForbiddenException('no inventory permission'),
    );

    await expect(
      service.adjustInventory(
        {
          storeId: 'store-1',
          productId: 'product-1',
          adjustment: 1,
          reason: 'count',
        },
        user,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);

    expect(access.ensureStoreAccess).toHaveBeenCalledWith(
      'store-1',
      user,
      'manage_inventory',
    );
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});
