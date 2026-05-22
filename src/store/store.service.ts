import {
  BadRequestException,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import {
  BillingCycle,
  Prisma,
  StaffRole,
  SubscriptionStatus,
} from '@prisma/client';
import { AuthTokenPayload } from '../auth/strategies/jwt.strategy';
import { PosAccessService } from '../common/pos-access.service';
import { PrismaService } from '../prisma.service';

@Injectable()
export class StoreService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: PosAccessService,
  ) {}

  calculateStorePricing(storeCount: number, billingCycle: BillingCycle) {
    if (storeCount < 1) {
      throw new BadRequestException('storeCount must be at least 1');
    }

    if (storeCount <= 2) {
      return billingCycle === BillingCycle.annual ? 300 : 30;
    }

    if (storeCount <= 10) {
      return billingCycle === BillingCycle.annual ? 250 : 25;
    }

    return billingCycle === BillingCycle.annual ? 200 : 20;
  }

  async canCreateStore(ownerId: string) {
    const subscription = await this.prisma.subscription.findFirst({
      where: {
        ownerId,
        status: { in: [SubscriptionStatus.trial, SubscriptionStatus.active] },
      },
      orderBy: { createdAt: 'desc' },
    });

    if (!subscription) {
      return {
        allowed: false,
        reason: 'An active or trial subscription is required to create a store',
      };
    }

    const activeStoreCount = await this.prisma.store.count({
      where: { ownerId, isActive: true },
    });

    if (
      subscription.maxStores !== null &&
      activeStoreCount >= subscription.maxStores
    ) {
      return {
        allowed: false,
        reason: 'Subscription store limit reached',
      };
    }

    return { allowed: true, subscription, activeStoreCount };
  }

  async create(body: Record<string, unknown>, user: AuthTokenPayload) {
    if (user.type !== StaffRole.owner) {
      throw new ForbiddenException('Only owners can create stores');
    }

    const dto = this.parseCreateBody(body);
    const creationCheck = await this.canCreateStore(user.accountId);

    if (!creationCheck.allowed || !creationCheck.subscription) {
      throw new ForbiddenException(creationCheck.reason);
    }

    const nextStoreCount = creationCheck.activeStoreCount + 1;
    const pricePerStore = this.calculateStorePricing(
      nextStoreCount,
      creationCheck.subscription.billingCycle,
    );

    const [store] = await this.prisma.$transaction([
      this.prisma.store.create({
        data: {
          name: dto.name,
          address: dto.address,
          ownerId: user.accountId,
        },
        include: this.storeInclude,
      }),
      this.prisma.subscription.update({
        where: { id: creationCheck.subscription.id },
        data: { pricePerStore },
      }),
    ]);

    return store;
  }

  async update(
    storeId: string,
    body: Record<string, unknown>,
    user: AuthTokenPayload,
  ) {
    await this.access.ensureStoreAccess(storeId, user, 'update_store');
    const updates = this.parseUpdateBody(body);

    return this.prisma.store.update({
      where: { id: storeId },
      data: updates,
      include: this.storeInclude,
    });
  }

  async remove(storeId: string, user: AuthTokenPayload) {
    const store = await this.access.ensureStoreAccess(
      storeId,
      user,
      'delete_store',
    );

    if (user.type !== StaffRole.owner || user.accountId !== store.ownerId) {
      throw new ForbiddenException('Only the owner can delete a store');
    }

    return this.prisma.store.update({
      where: { id: storeId },
      data: { isActive: false },
      include: this.storeInclude,
    });
  }

  async myStores(user: AuthTokenPayload) {
    if (user.type === StaffRole.owner) {
      return this.prisma.store.findMany({
        where: { ownerId: user.accountId, isActive: true },
        orderBy: { createdAt: 'desc' },
        include: this.storeInclude,
      });
    }

    return this.prisma.store.findMany({
      where: {
        isActive: true,
        staff: { some: { staffId: user.staffId } },
      },
      orderBy: { createdAt: 'desc' },
      include: this.storeInclude,
    });
  }

  async findOne(storeId: string, user: AuthTokenPayload) {
    await this.access.ensureStoreAccess(storeId, user, 'view_store');

    return this.prisma.store.findFirst({
      where: { id: storeId, isActive: true },
      include: this.storeInclude,
    });
  }

  private parseCreateBody(body: Record<string, unknown>) {
    return {
      name: this.requiredString(body.name, 'name'),
      address: this.optionalString(body.address, 'address'),
    };
  }

  private parseUpdateBody(
    body: Record<string, unknown>,
  ): Prisma.StoreUpdateInput {
    const updates: Prisma.StoreUpdateInput = {};

    if (body.name !== undefined) {
      updates.name = this.requiredString(body.name, 'name');
    }

    if (body.address !== undefined) {
      updates.address = this.optionalString(body.address, 'address');
    }

    return updates;
  }

  private requiredString(value: unknown, field: string) {
    if (typeof value !== 'string' || !value.trim()) {
      throw new BadRequestException(`${field} is required`);
    }

    return value.trim();
  }

  private optionalString(value: unknown, field: string) {
    if (value === undefined || value === null) {
      return null;
    }

    if (typeof value !== 'string') {
      throw new BadRequestException(`${field} must be a string`);
    }

    return value.trim() || null;
  }

  private readonly storeInclude = {
    departments: true,
    priceGroups: true,
    productCategories: true,
    taxes: true,
    products: true,
    staff: true,
  } satisfies Prisma.StoreInclude;
}
