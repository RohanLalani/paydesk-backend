import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
} from '@nestjs/common';
import { Prisma, ProductSaleType, StaffRole, TaxStyle } from '@prisma/client';
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

describe('ProductService item editor APIs', () => {
  let service: ProductService;
  let prisma: {
    department: { findFirst: jest.Mock };
    priceGroup: { findFirst: jest.Mock };
    productCategory: { findFirst: jest.Mock };
    tax: { findFirst: jest.Mock };
    product: { findFirst: jest.Mock; create?: jest.Mock };
    $transaction: jest.Mock;
  };
  let access: { ensureStoreAccess: jest.Mock };

  const user = {
    accountId: 'owner-1',
    staffId: 'staff-owner-1',
    role: StaffRole.owner,
    type: StaffRole.owner,
  };

  beforeEach(() => {
    prisma = {
      department: {
        findFirst: jest
          .fn()
          .mockResolvedValue({ id: 'department-1', defaultAllowEbt: true }),
      },
      priceGroup: { findFirst: jest.fn() },
      productCategory: { findFirst: jest.fn() },
      tax: { findFirst: jest.fn().mockResolvedValue({ id: 'tax-1' }) },
      product: { findFirst: jest.fn() },
      $transaction: jest.fn(
        async (callback: (tx: unknown) => Promise<unknown>) =>
          callback({
            product: {
              create: jest.fn().mockResolvedValue(productFixture()),
            },
            inventoryLog: { create: jest.fn() },
          }),
      ),
    };
    access = {
      ensureStoreAccess: jest.fn().mockResolvedValue(undefined),
    };
    service = new ProductService(
      prisma as unknown as PrismaService,
      access as unknown as PosAccessService,
    );
  });

  it('accepts null optional classification fields on create', async () => {
    await expect(
      service.create(
        createBody({
          priceGroupId: null,
          productCategoryId: null,
        }),
        user,
      ),
    ).resolves.toEqual(expect.objectContaining({ id: 'product-1' }));

    expect(prisma.priceGroup.findFirst).toHaveBeenCalledWith({
      where: { id: '__optional_price_group_not_selected__' },
    });
    expect(prisma.productCategory.findFirst).toHaveBeenCalledWith({
      where: { id: '__optional_category_not_selected__' },
    });
  });

  it('rejects invalid UPC and EAN check digits', async () => {
    await expect(
      service.create(createBody({ barcode: '036000291451' }), user),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('preserves leading zero barcodes during lookup', async () => {
    prisma.product.findFirst.mockResolvedValue(
      productFixture({ barcode: '012345678905' }),
    );

    await service.findByBarcode('store-1', '012345678905', user);

    expect(prisma.product.findFirst).toHaveBeenCalledWith({
      where: {
        storeId: 'store-1',
        barcode: '012345678905',
        isActive: true,
      },
      include: {
        department: true,
        priceGroup: true,
        productCategory: true,
        tax: true,
        store: true,
      },
    });
  });

  it('maps duplicate store barcode conflicts to 409', async () => {
    prisma.$transaction.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError('duplicate', {
        code: 'P2002',
        clientVersion: 'test',
      }),
    );

    await expect(service.create(createBody(), user)).rejects.toBeInstanceOf(
      ConflictException,
    );
  });
});

function createBody(overrides: Record<string, unknown> = {}) {
  return {
    storeId: 'store-1',
    barcode: '012345678905',
    name: 'Test Item',
    departmentId: 'department-1',
    priceGroupId: null,
    productCategoryId: null,
    saleType: ProductSaleType.piece,
    unitsPerCase: 1,
    unitRetail: 1.99,
    taxId: 'tax-1',
    taxStyle: TaxStyle.post_discount,
    ...overrides,
  };
}

function productFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: 'product-1',
    storeId: 'store-1',
    barcode: '012345678905',
    name: 'Test Item',
    currentQuantity: 0,
    ...overrides,
  };
}
