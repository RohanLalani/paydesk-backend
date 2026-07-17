/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { StaffRole, StorePermissionKey } from '@prisma/client';
import { PosAccessService } from '../common/pos-access.service';
import { PrismaService } from '../prisma.service';
import { PermissionsService } from './permissions.service';

describe('PermissionsService', () => {
  let service: PermissionsService;
  let prisma: MockPrisma;
  let access: MockAccess;

  const ownerUser = {
    accountId: 'owner-1',
    staffId: 'staff-owner-1',
    role: StaffRole.owner,
    type: StaffRole.owner,
  };
  const partnerUser = {
    accountId: 'partner-1',
    staffId: 'staff-partner-1',
    role: StaffRole.partner,
    type: StaffRole.partner,
  };
  const managerUser = {
    accountId: 'manager-1',
    staffId: 'staff-manager-1',
    role: StaffRole.manager,
    type: StaffRole.manager,
  };

  beforeEach(() => {
    prisma = createMockPrisma();
    access = {
      ensureStoreAccess: jest.fn().mockResolvedValue(storeFixture()),
      ownerPermissions: jest
        .fn()
        .mockReturnValue(Object.values(StorePermissionKey)),
      partnerPermissions: jest
        .fn()
        .mockReturnValue(
          Object.values(StorePermissionKey).filter(
            (permission) =>
              permission !== StorePermissionKey.add_store &&
              permission !== StorePermissionKey.delete_store,
          ),
        ),
      getEffectivePermissionsForStaff: jest
        .fn()
        .mockResolvedValue([
          StorePermissionKey.view_store,
          StorePermissionKey.process_sales,
        ]),
    };
    service = new PermissionsService(
      prisma as unknown as PrismaService,
      access as unknown as PosAccessService,
    );
  });

  it('lists available permission keys with labels and descriptions', () => {
    expect(service.keys()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: StorePermissionKey.manage_products,
          label: 'Manage Products',
          description: expect.any(String),
        }),
        expect.objectContaining({
          key: StorePermissionKey.manage_registers,
          label: 'Manage Registers',
          description: expect.any(String),
        }),
      ]),
    );
  });

  it('returns staff assigned to a store with effective permissions', async () => {
    prisma.storeStaff.findMany.mockResolvedValue([
      assignmentFixture({
        role: StaffRole.partner,
        staff: staffFixture({
          id: 'staff-partner-1',
          role: StaffRole.partner,
        }),
        permissions: [{ permission: StorePermissionKey.delete_store }],
      }),
      assignmentFixture({
        staff: staffFixture({
          id: 'staff-manager-1',
          role: StaffRole.manager,
        }),
        permissions: [{ permission: StorePermissionKey.process_sales }],
      }),
    ]);

    const result = await service.listStaffPermissions('store-1', ownerUser);

    expect(result).toEqual([
      expect.objectContaining({
        role: StaffRole.owner,
        permissions: Object.values(StorePermissionKey),
      }),
      expect.objectContaining({
        role: StaffRole.partner,
        permissions: expect.not.arrayContaining([
          StorePermissionKey.add_store,
          StorePermissionKey.delete_store,
        ]),
      }),
      expect.objectContaining({
        role: StaffRole.manager,
        permissions: [StorePermissionKey.process_sales],
      }),
    ]);
  });

  it('allows the owner to replace manager permissions', async () => {
    const result = await service.updateStaffPermissions(
      'store-1',
      'staff-manager-1',
      {
        permissions: [
          StorePermissionKey.view_store,
          StorePermissionKey.process_sales,
        ],
      },
      ownerUser,
    );

    expect(prisma.storeStaffPermission.deleteMany).toHaveBeenCalledWith({
      where: { storeStaffId: 'store-staff-1' },
    });
    expect(prisma.storeStaffPermission.createMany).toHaveBeenCalledWith({
      data: [
        {
          storeStaffId: 'store-staff-1',
          permission: StorePermissionKey.view_store,
        },
        {
          storeStaffId: 'store-staff-1',
          permission: StorePermissionKey.process_sales,
        },
      ],
      skipDuplicates: true,
    });
    expect(result.permissions).toEqual([
      StorePermissionKey.view_store,
      StorePermissionKey.process_sales,
    ]);
  });

  it('does not let partners change permissions', async () => {
    await expect(
      service.updateStaffPermissions(
        'store-1',
        'staff-manager-1',
        { permissions: [StorePermissionKey.view_store] },
        partnerUser,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('does not let managers or employees change permissions', async () => {
    await expect(
      service.updateStaffPermissions(
        'store-1',
        'staff-manager-1',
        { permissions: [StorePermissionKey.view_store] },
        managerUser,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('rejects invalid permission keys', async () => {
    await expect(
      service.updateStaffPermissions(
        'store-1',
        'staff-manager-1',
        { permissions: ['not_real'] },
        ownerUser,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

function createMockPrisma(): MockPrisma {
  const prisma = {
    store: {
      findFirst: jest.fn().mockResolvedValue(storeFixture()),
    },
    storeStaff: {
      findMany: jest.fn(),
      findUnique: jest.fn().mockResolvedValue(assignmentFixture()),
    },
    storeStaffPermission: {
      deleteMany: jest.fn().mockReturnValue({}),
      createMany: jest.fn().mockReturnValue({}),
    },
    $transaction: jest.fn(),
  };

  prisma.$transaction.mockImplementation(
    (callback: (tx: MockPrisma) => unknown) => callback(prisma),
  );

  return prisma;
}

function storeFixture() {
  return {
    id: 'store-1',
    ownerId: 'owner-1',
    isActive: true,
    owner: {
      id: 'owner-1',
      staffId: 'staff-owner-1',
      staff: staffFixture({
        id: 'staff-owner-1',
        role: StaffRole.owner,
      }),
    },
  };
}

function assignmentFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: 'store-staff-1',
    storeId: 'store-1',
    staffId: 'staff-manager-1',
    role: StaffRole.manager,
    staff: staffFixture(),
    permissions: [],
    ...overrides,
  };
}

function staffFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: 'staff-manager-1',
    email: 'manager@example.com',
    name: 'Manager',
    role: StaffRole.manager,
    ...overrides,
  };
}

type MockAccess = {
  ensureStoreAccess: jest.Mock;
  ownerPermissions: jest.Mock;
  partnerPermissions: jest.Mock;
  getEffectivePermissionsForStaff: jest.Mock;
};

type MockPrisma = {
  store: {
    findFirst: jest.Mock;
  };
  storeStaff: {
    findMany: jest.Mock;
    findUnique: jest.Mock;
  };
  storeStaffPermission: {
    deleteMany: jest.Mock;
    createMany: jest.Mock;
  };
  $transaction: jest.Mock;
};
