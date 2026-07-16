import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
} from '@nestjs/common';
import {
  DepartmentMinimumAge,
  DepartmentType,
  Prisma,
  ProductSaleType,
  StaffRole,
  TaxStyle,
} from '@prisma/client';
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
  let txProductCreate: jest.Mock<
    Promise<Record<string, unknown>>,
    [{ data: Record<string, unknown> }]
  >;
  let access: { ensureStoreAccess: jest.Mock };

  const user = {
    accountId: 'owner-1',
    staffId: 'staff-owner-1',
    role: StaffRole.owner,
    type: StaffRole.owner,
  };

  beforeEach(() => {
    txProductCreate = jest
      .fn<
        Promise<Record<string, unknown>>,
        [{ data: Record<string, unknown> }]
      >()
      .mockResolvedValue(productFixture());
    prisma = {
      department: {
        findFirst: jest
          .fn()
          .mockResolvedValue(departmentFixture({ allowEbt: true })),
      },
      priceGroup: { findFirst: jest.fn() },
      productCategory: { findFirst: jest.fn() },
      tax: { findFirst: jest.fn().mockResolvedValue({ id: 'tax-1' }) },
      product: { findFirst: jest.fn() },
      $transaction: jest.fn(
        async (callback: (tx: unknown) => Promise<unknown>) =>
          callback({
            product: {
              create: txProductCreate,
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

  it('uses department tax and defaults when creating a product', async () => {
    prisma.department.findFirst.mockResolvedValue(
      departmentFixture({
        defaultTaxId: 'department-tax',
        defaultTax: {
          id: 'department-tax',
          storeId: 'store-1',
          name: 'Department Tax',
          rate: new Prisma.Decimal('0.0625'),
          isActive: true,
        },
        allowEbt: true,
        trackInventory: false,
        allowNegativeInventorySales: true,
        minimumAge: DepartmentMinimumAge.age_21,
        defaultRetailMargin: new Prisma.Decimal('42.5'),
      }),
    );

    await service.create(
      createBody({
        taxId: 'frontend-tax',
        allowEbt: false,
        trackInventory: true,
        allowNegativeInventory: false,
        minimumAge: null,
      }),
      user,
    );

    const createArg = txProductCreate.mock.calls[0]?.[0] as
      | { data: Record<string, unknown> }
      | undefined;

    expect(createArg?.data).toEqual(
      expect.objectContaining({
        taxId: 'department-tax',
        allowEbt: true,
        trackInventory: false,
        allowNegativeInventory: true,
        minimumAge: 21,
        defaultMargin: 42.5,
      }),
    );
  });

  it('rejects product creation when department has no active default tax', async () => {
    prisma.department.findFirst.mockResolvedValue(
      departmentFixture({
        defaultTaxId: 'inactive-tax',
        defaultTax: {
          id: 'inactive-tax',
          storeId: 'store-1',
          name: 'Inactive Tax',
          rate: new Prisma.Decimal('0.0625'),
          isActive: false,
        },
      }),
    );

    await expect(service.create(createBody(), user)).rejects.toBeInstanceOf(
      BadRequestException,
    );

    expect(txProductCreate).not.toHaveBeenCalled();
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

describe('ProductService department management APIs', () => {
  let service: ProductService;
  let prisma: {
    department: {
      findFirst: jest.Mock;
      findMany: jest.Mock;
      count: jest.Mock;
      create: jest.Mock;
      update: jest.Mock;
    };
    tax: { findFirst: jest.Mock };
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
        findFirst: jest.fn(),
        findMany: jest.fn(),
        count: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
      },
      tax: { findFirst: jest.fn().mockResolvedValue({ id: 'tax-1' }) },
    };
    access = {
      ensureStoreAccess: jest.fn().mockResolvedValue(undefined),
    };
    service = new ProductService(
      prisma as unknown as PrismaService,
      access as unknown as PosAccessService,
    );
  });

  it('creates a normalized department for an authorized store', async () => {
    prisma.department.findFirst.mockResolvedValue(null);
    prisma.department.create.mockResolvedValue(
      departmentFixture({ name: 'Cold Drinks' }),
    );

    await expect(
      service.createStoreDepartment(
        'store-1',
        {
          name: '  Cold   Drinks  ',
          posDepartmentNumber: 10,
          type: DepartmentType.merchandise,
          defaultTaxId: 'tax-1',
          allowEbt: true,
          isActive: true,
        },
        user,
      ),
    ).resolves.toEqual(expect.objectContaining({ name: 'Cold Drinks' }));

    expect(access.ensureStoreAccess).toHaveBeenCalledWith(
      'store-1',
      user,
      'manage_products',
    );
    expect(prisma.department.create).toHaveBeenCalledWith({
      data: {
        storeId: 'store-1',
        name: 'Cold Drinks',
        posDepartmentNumber: 10,
        type: DepartmentType.merchandise,
        defaultTaxId: 'tax-1',
        minimumAge: DepartmentMinimumAge.none,
        defaultRetailMargin: null,
        minimumRingUpAmount: null,
        maximumRingUpAmount: null,
        trackInventory: true,
        allowNegativeInventorySales: false,
        allowEbt: true,
        defaultAllowEbt: true,
        allowManualRingUp: false,
        onPos: true,
        isActive: true,
      },
      include: {
        _count: { select: { products: true } },
        defaultTax: true,
      },
    });
  });

  it('rejects whitespace-only names', async () => {
    await expect(
      service.createStoreDepartment(
        'store-1',
        {
          name: '   ',
          posDepartmentNumber: 10,
          type: DepartmentType.merchandise,
          defaultTaxId: 'tax-1',
          allowEbt: false,
          isActive: true,
        },
        user,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(prisma.department.create).not.toHaveBeenCalled();
  });

  it('rejects duplicate names in the same store case-insensitively', async () => {
    prisma.department.findFirst.mockResolvedValue(
      departmentFixture({ id: 'department-existing', name: 'Beverages' }),
    );

    await expect(
      service.createStoreDepartment(
        'store-1',
        {
          name: ' beverages ',
          posDepartmentNumber: 10,
          type: DepartmentType.merchandise,
          defaultTaxId: 'tax-1',
          allowEbt: false,
          isActive: true,
        },
        user,
      ),
    ).rejects.toBeInstanceOf(ConflictException);

    expect(prisma.department.create).not.toHaveBeenCalled();
  });

  it('allows unchanged current name during edit', async () => {
    prisma.department.findFirst
      .mockResolvedValueOnce(departmentFixture())
      .mockResolvedValueOnce(null);
    prisma.department.update.mockResolvedValue(
      departmentFixture({ allowEbt: true, defaultAllowEbt: true }),
    );

    await expect(
      service.updateStoreDepartment(
        'store-1',
        'department-1',
        { name: 'Beverages', allowEbt: true },
        user,
      ),
    ).resolves.toEqual(expect.objectContaining({ defaultAllowEbt: true }));

    expect(prisma.department.findFirst).toHaveBeenNthCalledWith(2, {
      where: {
        storeId: 'store-1',
        name: { equals: 'Beverages', mode: 'insensitive' },
        id: { not: 'department-1' },
      },
      select: { id: true },
    });
  });

  it('rejects cross-store department updates', async () => {
    prisma.department.findFirst.mockResolvedValue(null);

    await expect(
      service.updateStoreDepartment(
        'store-1',
        'department-other',
        { name: 'Beverages' },
        user,
      ),
    ).rejects.toBeInstanceOf(Error);

    expect(prisma.department.update).not.toHaveBeenCalled();
  });

  it('deactivates departments without deleting them', async () => {
    prisma.department.findFirst.mockResolvedValue(departmentFixture());
    prisma.department.update.mockResolvedValue(
      departmentFixture({ isActive: false }),
    );

    await service.updateStoreDepartment(
      'store-1',
      'department-1',
      { isActive: false },
      user,
    );

    expect(prisma.department.update).toHaveBeenCalledWith({
      where: { id: 'department-1' },
      data: { isActive: false },
      include: {
        _count: { select: { products: true } },
        defaultTax: true,
      },
    });
  });

  it('lists inactive departments when active=false is requested', async () => {
    prisma.department.findMany.mockResolvedValue([
      {
        ...departmentFixture({ isActive: false }),
        _count: { products: 2 },
      },
    ]);
    prisma.department.count.mockResolvedValue(1);

    await expect(
      service.listStoreDepartments('store-1', user, { active: 'false' }),
    ).resolves.toEqual({
      items: [expect.objectContaining({ isActive: false, productCount: 2 })],
      total: 1,
      page: 1,
      limit: 100,
    });

    expect(prisma.department.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { storeId: 'store-1', isActive: false },
      }),
    );
  });

  it('rejects invalid sort values', async () => {
    await expect(
      service.listStoreDepartments('store-1', user, { sort: 'barcode' }),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(prisma.department.findMany).not.toHaveBeenCalled();
  });

  it('rejects invalid limit values', async () => {
    await expect(
      service.listStoreDepartments('store-1', user, { limit: 'many' }),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(prisma.department.findMany).not.toHaveBeenCalled();
  });

  it('searches departments by name', async () => {
    prisma.department.findMany.mockResolvedValue([
      {
        ...departmentFixture({ name: 'Cold Drinks' }),
        _count: { products: 0 },
      },
    ]);
    prisma.department.count.mockResolvedValue(1);

    await service.listStoreDepartments('store-1', user, {
      search: ' cold ',
      sort: 'name',
      order: 'asc',
      limit: '100',
    });

    expect(prisma.department.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          storeId: 'store-1',
          OR: [{ name: { contains: 'cold', mode: 'insensitive' } }],
        },
        orderBy: [{ name: 'asc' }, { posDepartmentNumber: 'asc' }],
        take: 100,
      }),
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

function departmentFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: 'department-1',
    storeId: 'store-1',
    name: 'Beverages',
    posDepartmentNumber: 10,
    type: DepartmentType.merchandise,
    defaultTaxId: 'tax-1',
    defaultTax: {
      id: 'tax-1',
      storeId: 'store-1',
      name: 'Sales Tax',
      rate: new Prisma.Decimal('0.0825'),
      isActive: true,
    },
    minimumAge: DepartmentMinimumAge.none,
    defaultRetailMargin: null,
    minimumRingUpAmount: null,
    maximumRingUpAmount: null,
    trackInventory: true,
    allowNegativeInventorySales: false,
    allowEbt: false,
    defaultAllowEbt: false,
    allowManualRingUp: false,
    onPos: true,
    isActive: true,
    _count: { products: 0 },
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-02T00:00:00.000Z'),
    ...overrides,
  };
}
