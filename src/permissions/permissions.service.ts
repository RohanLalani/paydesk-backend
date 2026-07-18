import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import {
  AuditAction,
  AuditEntityType,
  StaffRole,
  StorePermissionKey,
} from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { AuthTokenPayload } from '../auth/strategies/jwt.strategy';
import { PosAccessService } from '../common/pos-access.service';
import { PrismaService } from '../prisma.service';

const PERMISSION_DEFINITIONS: PermissionDefinition[] = [
  {
    key: StorePermissionKey.view_store,
    label: 'View Store',
    description: 'Can view store details and assigned store data',
  },
  {
    key: StorePermissionKey.add_store,
    label: 'Add Store',
    description: 'Can add stores for the owner account',
  },
  {
    key: StorePermissionKey.edit_store,
    label: 'Edit Store',
    description: 'Can edit store name and address',
  },
  {
    key: StorePermissionKey.delete_store,
    label: 'Delete Store',
    description: 'Can delete stores',
  },
  {
    key: StorePermissionKey.manage_products,
    label: 'Manage Products',
    description: 'Can add, edit, and delete products and catalog setup',
  },
  {
    key: StorePermissionKey.manage_multi_pack_pricing,
    label: 'Manage Multi-Pack Pricing',
    description: 'Can submit multi-pack pricing changes for review',
  },
  {
    key: StorePermissionKey.review_multi_pack_pricing,
    label: 'Review Multi-Pack Pricing',
    description: 'Can approve or reject submitted multi-pack pricing changes',
  },
  {
    key: StorePermissionKey.manage_inventory,
    label: 'Manage Inventory',
    description: 'Can receive, adjust, and change inventory',
  },
  {
    key: StorePermissionKey.view_purchases,
    label: 'View Purchases',
    description: 'Can view store purchase history and supplier invoices.',
  },
  {
    key: StorePermissionKey.manage_purchases,
    label: 'Manage Purchases',
    description: 'Can create and update store purchases.',
  },
  {
    key: StorePermissionKey.manage_payees,
    label: 'Manage Payees',
    description: 'Can create and update store payees.',
  },
  {
    key: StorePermissionKey.manage_customers,
    label: 'Manage Customers',
    description: 'Can add and edit customers and loyalty settings',
  },
  {
    key: StorePermissionKey.manage_employees,
    label: 'Manage Employees',
    description: 'Can manage employee assignments',
  },
  {
    key: StorePermissionKey.manage_registers,
    label: 'Manage Registers',
    description:
      'Allows adding, editing, deactivating, revoking, and managing POS registers for a store.',
  },
  {
    key: StorePermissionKey.view_audit_logs,
    label: 'View Audit Logs',
    description: 'Can review back-office activity and audit history.',
  },
  {
    key: StorePermissionKey.view_reports,
    label: 'View Reports',
    description: 'Can view store reports',
  },
  {
    key: StorePermissionKey.process_sales,
    label: 'Process Sales',
    description: 'Can create carts and complete checkout',
  },
  {
    key: StorePermissionKey.override_prices,
    label: 'Override Prices',
    description: 'Can override item prices during sales',
  },
];

const PERMISSION_KEYS = new Set<StorePermissionKey>(
  PERMISSION_DEFINITIONS.map((definition) => definition.key),
);
type AuditRecorder = {
  record: (...args: Parameters<AuditService['record']>) => Promise<unknown>;
};

const NOOP_AUDIT: AuditRecorder = { record: () => Promise.resolve(null) };

@Injectable()
export class PermissionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: PosAccessService,
    @Optional()
    private readonly audit: AuditService = NOOP_AUDIT as unknown as AuditService,
  ) {}

  keys() {
    return PERMISSION_DEFINITIONS;
  }

  async listStaffPermissions(storeId: string, user: AuthTokenPayload) {
    const store = await this.ensureCanViewPermissions(storeId, user);

    const assignments = await this.prisma.storeStaff.findMany({
      where: { storeId: store.id },
      orderBy: { createdAt: 'asc' },
      include: {
        staff: {
          select: {
            id: true,
            email: true,
            name: true,
            role: true,
          },
        },
        permissions: true,
      },
    });

    return [
      {
        staff: store.owner.staff,
        role: StaffRole.owner,
        permissions: this.access.ownerPermissions(),
      },
      ...assignments.map((assignment) => ({
        staff: assignment.staff,
        role: assignment.role,
        permissions: this.effectivePermissionsForAssignment(assignment),
      })),
    ];
  }

  async getStaffPermissions(
    storeId: string,
    staffId: string,
    user: AuthTokenPayload,
  ) {
    await this.ensureCanViewPermissions(storeId, user);
    const staff = await this.findStoreStaffOrOwner(storeId, staffId);

    return {
      staff: staff.staff,
      role: staff.role,
      permissions: await this.access.getEffectivePermissionsForStaff(
        storeId,
        staffId,
      ),
    };
  }

  async updateStaffPermissions(
    storeId: string,
    staffId: string,
    body: Record<string, unknown>,
    user: AuthTokenPayload,
  ) {
    const store = await this.ensureOwner(storeId, user);

    if (store.owner.staffId === staffId) {
      throw new BadRequestException('Owner permissions cannot be edited');
    }

    const assignment = await this.prisma.storeStaff.findUnique({
      where: {
        storeId_staffId: {
          storeId,
          staffId,
        },
      },
      include: {
        staff: {
          select: {
            id: true,
            email: true,
            name: true,
            role: true,
          },
        },
      },
    });

    if (!assignment) {
      throw new NotFoundException('Staff assignment not found');
    }

    const beforePermissions = await this.access.getEffectivePermissionsForStaff(
      storeId,
      staffId,
    );
    const permissions = this.parsePermissions(body);

    await this.prisma.$transaction(async (tx) => {
      await tx.storeStaffPermission.deleteMany({
        where: { storeStaffId: assignment.id },
      });

      if (permissions.length) {
        await tx.storeStaffPermission.createMany({
          data: permissions.map((permission) => ({
            storeStaffId: assignment.id,
            permission,
          })),
          skipDuplicates: true,
        });
      }

      await this.audit.record(tx, {
        storeId,
        actorId: user.staffId,
        ownerId: store.owner.id,
        action: AuditAction.update,
        entityType: AuditEntityType.staff_permission,
        entityId: assignment.staff.id,
        entityName: assignment.staff.name ?? assignment.staff.email,
        summary: `Updated permissions for ${assignment.staff.name ?? assignment.staff.email}`,
        before: { permissions: beforePermissions },
        after: { permissions },
      });
    });

    return {
      staff: assignment.staff,
      role: assignment.role,
      permissions: await this.access.getEffectivePermissionsForStaff(
        storeId,
        staffId,
      ),
    };
  }

  private async ensureCanViewPermissions(
    storeId: string,
    user: AuthTokenPayload,
  ) {
    await this.access.ensureStoreAccess(
      storeId,
      user,
      StorePermissionKey.view_store,
    );

    const store = await this.prisma.store.findFirst({
      where: { id: storeId, isActive: true },
      include: {
        owner: {
          select: {
            id: true,
            staffId: true,
            staff: {
              select: {
                id: true,
                email: true,
                name: true,
                role: true,
              },
            },
          },
        },
      },
    });

    if (!store) {
      throw new NotFoundException('Store not found');
    }

    return store;
  }

  private async ensureOwner(storeId: string, user: AuthTokenPayload) {
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

    if (user.type !== StaffRole.owner || user.accountId !== store.ownerId) {
      throw new ForbiddenException(
        'Only the store owner can change permissions',
      );
    }

    return store;
  }

  private async findStoreStaffOrOwner(storeId: string, staffId: string) {
    const store = await this.prisma.store.findFirst({
      where: { id: storeId, isActive: true },
      include: {
        owner: {
          select: {
            staffId: true,
            staff: {
              select: {
                id: true,
                email: true,
                name: true,
                role: true,
              },
            },
          },
        },
      },
    });

    if (!store) {
      throw new NotFoundException('Store not found');
    }

    if (store.owner.staffId === staffId) {
      return {
        staff: store.owner.staff,
        role: StaffRole.owner,
      };
    }

    const assignment = await this.prisma.storeStaff.findUnique({
      where: {
        storeId_staffId: {
          storeId,
          staffId,
        },
      },
      include: {
        staff: {
          select: {
            id: true,
            email: true,
            name: true,
            role: true,
          },
        },
      },
    });

    if (!assignment) {
      throw new NotFoundException('Staff assignment not found');
    }

    return {
      staff: assignment.staff,
      role: assignment.role,
    };
  }

  private effectivePermissionsForAssignment(assignment: {
    role: StaffRole;
    permissions: { permission: StorePermissionKey }[];
  }) {
    if (assignment.role === StaffRole.partner) {
      return this.access.partnerPermissions();
    }

    return assignment.permissions.map((row) => row.permission);
  }

  private parsePermissions(body: Record<string, unknown>) {
    const permissions = body.permissions;

    if (!Array.isArray(permissions)) {
      throw new BadRequestException('permissions must be an array');
    }

    return permissions.map((permission, index) => {
      if (
        typeof permission !== 'string' ||
        !PERMISSION_KEYS.has(permission as StorePermissionKey)
      ) {
        throw new BadRequestException(
          `permissions.${index} must be a valid permission key`,
        );
      }

      return permission as StorePermissionKey;
    });
  }
}

type PermissionDefinition = {
  key: StorePermissionKey;
  label: string;
  description: string;
};
