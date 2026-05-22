import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { StaffRole } from '@prisma/client';
import { AuthTokenPayload } from '../auth/strategies/jwt.strategy';
import { PrismaService } from '../prisma.service';

export type StorePermission =
  | 'view_store'
  | 'update_store'
  | 'delete_store'
  | 'manage_products'
  | 'manage_departments'
  | 'manage_price_groups'
  | 'manage_product_categories'
  | 'manage_taxes'
  | 'update_inventory'
  | 'manage_employees';

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

    if (await this.canAccessStore(store, user, permission)) {
      return store;
    }

    throw new ForbiddenException('You do not have access to this store');
  }

  async canAccessStore(
    store: { id: string; ownerId: string },
    user: AuthTokenPayload,
    permission: StorePermission,
  ) {
    if (user.type === StaffRole.owner && user.accountId === store.ownerId) {
      return true;
    }

    const storeStaff = await this.prisma.storeStaff.findUnique({
      where: {
        storeId_staffId: {
          storeId: store.id,
          staffId: user.staffId,
        },
      },
    });

    if (!storeStaff) {
      return false;
    }

    return this.roleCan(storeStaff.role, permission);
  }

  roleCan(role: StaffRole, permission: StorePermission) {
    if (role === StaffRole.owner) {
      return true;
    }

    if (role === StaffRole.partner) {
      return permission !== 'delete_store';
    }

    if (role === StaffRole.manager) {
      return [
        'view_store',
        'manage_products',
        'manage_departments',
        'manage_price_groups',
        'manage_product_categories',
        'manage_taxes',
        'update_inventory',
      ].includes(permission);
    }

    return permission === 'view_store';
  }
}
