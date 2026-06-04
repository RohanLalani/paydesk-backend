import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
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

  calculateStorePricing(activeStoreCount: number, billingCycle: BillingCycle) {
    if (activeStoreCount < 0) {
      throw new BadRequestException('activeStoreCount cannot be negative');
    }

    const monthlyPricePerStore =
      activeStoreCount === 0
        ? 0
        : this.getTierPrice(activeStoreCount, BillingCycle.monthly);
    const annualPricePerStore =
      activeStoreCount === 0
        ? 0
        : this.getTierPrice(activeStoreCount, BillingCycle.annual);

    return {
      activeStoreCount,
      pricePerStore:
        billingCycle === BillingCycle.annual
          ? annualPricePerStore
          : monthlyPricePerStore,
      totalMonthlyAmount: activeStoreCount * monthlyPricePerStore,
      totalAnnualAmount: activeStoreCount * annualPricePerStore,
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
      subscription.billingCycle,
    );

    return tx.subscription.update({
      where: { id: subscription.id },
      data: pricing,
    });
  }

  async assertCanManageStore(user: AuthTokenPayload, storeId: string) {
    return this.access.ensureStoreAccess(storeId, user, 'edit_store');
  }

  async create(body: Record<string, unknown>, user: AuthTokenPayload) {
    if (user.type !== StaffRole.owner) {
      throw new ForbiddenException('Only owners can create stores');
    }

    const dto = this.parseCreateBody(body);

    return this.prisma.$transaction(async (tx) => {
      const creationCheck = await this.canCreateStore(user.accountId, tx);

      if (!creationCheck.allowed || !creationCheck.subscription) {
        throw new ForbiddenException(creationCheck.reason);
      }

      const store = await tx.store.create({
        data: {
          name: dto.name,
          address: dto.address,
          ownerId: user.accountId,
        },
        include: this.storeInclude,
      });

      await this.updateOwnerBilling(user.accountId, tx);

      return store;
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

    if (!Object.keys(updates).length) {
      throw new BadRequestException(
        'At least one of name or address is required',
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

  private getTierPrice(activeStoreCount: number, billingCycle: BillingCycle) {
    if (activeStoreCount <= 2) {
      return billingCycle === BillingCycle.annual ? 300 : 30;
    }

    if (activeStoreCount <= 10) {
      return billingCycle === BillingCycle.annual ? 250 : 25;
    }

    return billingCycle === BillingCycle.annual ? 200 : 20;
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

  private readonly storeInclude = {
    departments: true,
    priceGroups: true,
    productCategories: true,
    taxes: true,
    products: true,
    staff: true,
  } satisfies Prisma.StoreInclude;
}
