import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  Prisma,
  StaffRole,
  StoreBusinessType,
  SubscriptionPlan,
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

  calculateStorePricing(activeStoreCount: number, plan: SubscriptionPlan) {
    if (activeStoreCount < 0) {
      throw new BadRequestException('activeStoreCount cannot be negative');
    }

    const monthlyPricePerStore = this.getPlanMonthlyPrice(plan);

    return {
      activeStoreCount,
      pricePerStore: monthlyPricePerStore,
      totalMonthlyAmount: activeStoreCount * monthlyPricePerStore,
      totalAnnualAmount: activeStoreCount * monthlyPricePerStore * 12,
    };
  }

  getActiveStoreCount(
    ownerId: string,
    tx: Prisma.TransactionClient = this.prisma,
  ) {
    return tx.store.count({
      where: { ownerId, isActive: true },
    });
  }

  async canCreateStore(
    ownerId: string,
    tx: Prisma.TransactionClient = this.prisma,
  ) {
    const subscription = await tx.subscription.findFirst({
      where: this.activeSubscriptionWhere(ownerId),
      orderBy: { createdAt: 'desc' },
    });

    if (!subscription) {
      return {
        allowed: false,
        reason: 'An active or trial subscription is required to create a store',
      };
    }

    const activeStoreCount = await this.getActiveStoreCount(ownerId, tx);

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

  async updateOwnerBilling(
    ownerId: string,
    tx: Prisma.TransactionClient = this.prisma,
  ) {
    const subscription = await tx.subscription.findFirst({
      where: this.activeSubscriptionWhere(ownerId),
      orderBy: { createdAt: 'desc' },
    });

    if (!subscription) {
      return null;
    }

    const activeStoreCount = await this.getActiveStoreCount(ownerId, tx);
    const pricing = this.calculateStorePricing(
      activeStoreCount,
      subscription.plan,
    );

    return tx.subscription.update({
      where: { id: subscription.id },
      data: pricing,
    });
  }

  async getOwnerSubscription(user: AuthTokenPayload) {
    this.assertOwner(user);

    const subscription = await this.prisma.subscription.findFirst({
      where: this.activeSubscriptionWhere(user.accountId),
      orderBy: { createdAt: 'desc' },
      include: { addons: true },
    });

    if (!subscription) {
      throw new NotFoundException('Active or trial subscription not found');
    }

    const activeStoreCount = await this.getActiveStoreCount(user.accountId);
    const pricing = this.calculateStorePricing(
      activeStoreCount,
      subscription.plan,
    );

    return {
      ...subscription,
      ...pricing,
    };
  }

  async updateSubscriptionPlan(
    body: Record<string, unknown>,
    user: AuthTokenPayload,
  ) {
    this.assertOwner(user);
    const plan = this.requiredSubscriptionPlan(body.plan);

    return this.prisma.$transaction(async (tx) => {
      const subscription = await tx.subscription.findFirst({
        where: this.activeSubscriptionWhere(user.accountId),
        orderBy: { createdAt: 'desc' },
      });

      if (!subscription) {
        throw new NotFoundException('Active or trial subscription not found');
      }

      const activeStoreCount = await this.getActiveStoreCount(
        user.accountId,
        tx,
      );
      const pricing = this.calculateStorePricing(activeStoreCount, plan);

      return tx.subscription.update({
        where: { id: subscription.id },
        data: {
          plan,
          ...pricing,
        },
        include: { addons: true },
      });
    });
  }

  async assertCanManageStore(user: AuthTokenPayload, storeId: string) {
    return this.access.ensureStoreAccess(storeId, user, 'edit_store');
  }

  async create(body: Record<string, unknown>, user: AuthTokenPayload) {
    this.assertOwner(user, 'Only owners can create stores');

    const dto = this.parseCreateBody(body);

    return this.prisma.store.create({
      data: {
        name: dto.name,
        address: dto.address,
        businessType: dto.businessType,
        ownerId: user.accountId,
        isActive: false,
      },
      include: this.storeInclude,
    });
  }

  async activateStore(storeId: string, user: AuthTokenPayload) {
    this.assertOwner(user, 'Only owners can activate stores');

    return this.prisma.$transaction(async (tx) => {
      const store = await tx.store.findUnique({
        where: { id: storeId },
      });

      if (!store) {
        throw new NotFoundException('Store not found');
      }

      if (store.ownerId !== user.accountId) {
        throw new ForbiddenException(
          'Only the store owner can activate this store',
        );
      }

      if (store.isActive) {
        return tx.store.findUnique({
          where: { id: store.id },
          include: this.storeInclude,
        });
      }

      const creationCheck = await this.canCreateStore(user.accountId, tx);

      if (!creationCheck.allowed || !creationCheck.subscription) {
        throw new ForbiddenException(
          creationCheck.reason === 'Subscription store limit reached'
            ? 'Subscription store limit reached.'
            : 'You need an active subscription before activating a store.',
        );
      }

      const activatedStore = await tx.store.update({
        where: { id: store.id },
        data: { isActive: true },
        include: this.storeInclude,
      });

      await this.updateOwnerBilling(user.accountId, tx);

      return activatedStore;
    });
  }

  async update(
    storeId: string,
    body: Record<string, unknown>,
    user: AuthTokenPayload,
  ) {
    await this.assertCanManageStore(user, storeId);
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

    return this.prisma.$transaction(async (tx) => {
      const deletedStore = await tx.store.update({
        where: { id: storeId },
        data: { isActive: false },
        include: this.storeInclude,
      });

      await this.updateOwnerBilling(store.ownerId, tx);

      return deletedStore;
    });
  }

  async myStores(user: AuthTokenPayload, includeInactive = false) {
    if (user.type === StaffRole.owner) {
      return this.prisma.store.findMany({
        where: {
          ownerId: user.accountId,
          ...(includeInactive ? {} : { isActive: true }),
        },
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
      businessType: this.requiredBusinessType(body.businessType),
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

    if (body.businessType !== undefined) {
      updates.businessType = this.requiredBusinessType(body.businessType);
    }

    if (!Object.keys(updates).length) {
      throw new BadRequestException(
        'At least one of name, address, or businessType is required',
      );
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

  private requiredBusinessType(value: unknown) {
    if (typeof value !== 'string' || !value.trim()) {
      throw new BadRequestException('businessType is required');
    }

    if (
      !Object.values(StoreBusinessType).includes(value as StoreBusinessType)
    ) {
      throw new BadRequestException(
        'businessType must be a valid store business type',
      );
    }

    return value as StoreBusinessType;
  }

  getPlanMonthlyPrice(plan: SubscriptionPlan) {
    switch (plan) {
      case SubscriptionPlan.plus:
        return 50;
      case SubscriptionPlan.advanced:
        return 80;
    }
  }

  private activeSubscriptionWhere(
    ownerId: string,
  ): Prisma.SubscriptionWhereInput {
    const now = new Date();

    return {
      ownerId,
      OR: [
        {
          status: SubscriptionStatus.active,
          OR: [
            { currentPeriodEndsAt: null },
            { currentPeriodEndsAt: { gt: now } },
          ],
        },
        {
          status: SubscriptionStatus.trial,
          OR: [{ trialEndsAt: null }, { trialEndsAt: { gt: now } }],
        },
      ],
    };
  }

  private assertOwner(
    user: AuthTokenPayload,
    message = 'Only owners can manage billing',
  ) {
    if (user.type !== StaffRole.owner) {
      throw new ForbiddenException(message);
    }
  }

  private requiredSubscriptionPlan(value: unknown) {
    if (typeof value !== 'string' || !value.trim()) {
      throw new BadRequestException('plan is required');
    }

    if (!Object.values(SubscriptionPlan).includes(value as SubscriptionPlan)) {
      throw new BadRequestException('plan must be plus or advanced');
    }

    return value as SubscriptionPlan;
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
