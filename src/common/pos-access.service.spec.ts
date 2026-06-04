import { ForbiddenException } from '@nestjs/common';
import { StaffRole, StorePermissionKey } from '@prisma/client';
import { PrismaService } from '../prisma.service';
import { PosAccessService } from './pos-access.service';

describe('PosAccessService', () => {
  let service: PosAccessService;
  let prisma: MockPrisma;

  const store = {
    id: 'store-1',
    ownerId: 'owner-1',
    isActive: true,
  };

  beforeEach(() => {
    prisma = {
      store: {
        findFirst: jest.fn().mockResolvedValue(store),
      },
      storeStaff: {
        findUnique: jest.fn(),
      },
    };
    service = new PosAccessService(prisma as unknown as PrismaService);
  });

  it('gives store owners every permission by default', async () => {
    const permissions = await service.getEffectivePermissions('store-1', {
      accountId: 'owner-1',
      staffId: 'staff-owner-1',
      role: StaffRole.owner,
      type: StaffRole.owner,
    });

    expect(permissions).toEqual(Object.values(StorePermissionKey));
  });

  it('gives partners every permission except delete_store by default', async () => {
    prisma.storeStaff.findUnique.mockResolvedValue({
      id: 'store-staff-partner-1',
      storeId: 'store-1',
      staffId: 'staff-partner-1',
      role: StaffRole.partner,
      permissions: [],
    });

    const permissions = await service.getEffectivePermissions('store-1', {
      accountId: 'partner-1',
      staffId: 'staff-partner-1',
      role: StaffRole.partner,
      type: StaffRole.partner,
    });

    expect(permissions).toContain(StorePermissionKey.manage_products);
    expect(permissions).toContain(StorePermissionKey.override_prices);
    expect(permissions).not.toContain(StorePermissionKey.delete_store);
  });

  it('allows managers and employees only through stored permissions', async () => {
    prisma.storeStaff.findUnique.mockResolvedValue({
      id: 'store-staff-manager-1',
      storeId: 'store-1',
      staffId: 'staff-manager-1',
      role: StaffRole.manager,
      permissions: [
        { permission: StorePermissionKey.view_store },
        { permission: StorePermissionKey.manage_inventory },
      ],
    });

    await expect(
      service.ensureStoreAccess('store-1', managerUser(), 'manage_inventory'),
    ).resolves.toEqual(store);

    await expect(
      service.ensureStoreAccess('store-1', managerUser(), 'process_sales'),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('blocks delete_store for partners', async () => {
    prisma.storeStaff.findUnique.mockResolvedValue({
      id: 'store-staff-partner-1',
      storeId: 'store-1',
      staffId: 'staff-partner-1',
      role: StaffRole.partner,
      permissions: [{ permission: StorePermissionKey.delete_store }],
    });

    await expect(
      service.ensureStoreAccess('store-1', {
        accountId: 'partner-1',
        staffId: 'staff-partner-1',
        role: StaffRole.partner,
        type: StaffRole.partner,
      }, 'delete_store'),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});

function managerUser() {
  return {
    accountId: 'manager-1',
    staffId: 'staff-manager-1',
    role: StaffRole.manager,
    type: StaffRole.manager,
  };
}

type MockPrisma = {
  store: {
    findFirst: jest.Mock;
  };
  storeStaff: {
    findUnique: jest.Mock;
  };
};
