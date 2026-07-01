import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { StaffRole, StorePermissionKey } from '@prisma/client';
import { AuthTokenPayload } from '../auth/strategies/jwt.strategy';
import { PrismaService } from '../prisma.service';

const ALL_STORE_PERMISSIONS = Object.values(StorePermissionKey);
const PARTNER_DEFAULT_DENIED = new Set<StorePermissionKey>([
  StorePermissionKey.add_store,
  StorePermissionKey.delete_store,
]);

const LEGACY_PERMISSION_MAP = {
  update_store: StorePermissionKey.edit_store,
  manage_departments: StorePermissionKey.manage_products,
  manage_price_groups: StorePermissionKey.manage_products,
  manage_product_categories: StorePermissionKey.manage_products,
  manage_taxes: StorePermissionKey.manage_products,
  update_inventory: StorePermissionKey.manage_inventory,
} as const;

export type StorePermission =
  | StorePermissionKey
  | keyof typeof LEGACY_PERMISSION_MAP;

@Injectable()
export class PosAccessService {
  constructor(private readonly prisma: PrismaService) {}

  async ensureStoreAccess(
    storeId: string,
    user: AuthTokenPayload,
    permission: StorePermission,
  ) {
    const store = await this.prisma.store.findFirst({
      where: { id: storeId, isActive: true },
    });

    if (!store) {
      throw new NotFoundException('Store not found');
    }

    const normalizedPermission = this.normalizePermission(permission);
    const permissions = await this.getEffectivePermissionsForStore(store, user);

    if (permissions.includes(normalizedPermission)) {
      return store;
    }

    throw new ForbiddenException('You do not have access to this store');
  }

  async getEffectivePermissions(storeId: string, user: AuthTokenPayload) {
    const store = await this.prisma.store.findFirst({
      where: { id: storeId, isActive: true },
    });

    if (!store) {
      throw new NotFoundException('Store not found');
    }

    return this.getEffectivePermissionsForStore(store, user);
  }

  async getEffectivePermissionsForStaff(storeId: string, staffId: string) {
    const store = await this.prisma.store.findFirst({
      where: { id: storeId, isActive: true },
      include: {
        owner: {
          select: {
            id: true,
            staffId: true,
          },
        },
      },
    });

    if (!store) {
      throw new NotFoundException('Store not found');
    }

    if (store.owner.staffId === staffId) {
      return this.ownerPermissions();
    }

    const assignment = await this.prisma.storeStaff.findUnique({
      where: {
        storeId_staffId: {
          storeId,
          staffId,
        },
      },
      include: {
        permissions: true,
        staff: {
          select: {
            role: true,
          },
        },
      },
    });

    if (!assignment) {
      throw new NotFoundException('Staff assignment not found');
    }

    if (assignment.staff.role === StaffRole.partner) {
      return this.partnerPermissions();
    }

    return assignment.permissions.map((row) => row.permission);
  }

  ownerPermissions() {
    return [...ALL_STORE_PERMISSIONS];
  }

  partnerPermissions() {
    return ALL_STORE_PERMISSIONS.filter(
      (permission) => !PARTNER_DEFAULT_DENIED.has(permission),
    );
  }

  private async getEffectivePermissionsForStore(
    store: { id: string; ownerId: string },
    user: AuthTokenPayload,
  ) {
    if (user.type === StaffRole.owner && user.accountId === store.ownerId) {
      return this.ownerPermissions();
    }

    const assignment = await this.prisma.storeStaff.findUnique({
      where: {
        storeId_staffId: {
          storeId: store.id,
          staffId: user.staffId,
        },
      },
      include: {
        permissions: true,
      },
    });

    if (!assignment) {
      return [];
    }

    if (user.type === StaffRole.partner) {
      return this.partnerPermissions();
    }

    return assignment.permissions.map((row) => row.permission);
  }

  private normalizePermission(permission: StorePermission) {
    return (
      LEGACY_PERMISSION_MAP[permission as keyof typeof LEGACY_PERMISSION_MAP] ??
      permission
    );
  }
}
