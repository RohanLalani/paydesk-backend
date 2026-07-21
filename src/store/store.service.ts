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
  Prisma,
  StaffRole,
  StoreFeatureKey,
  StoreFeatureSource,
  StoreBusinessType,
  StoreServiceKey,
  StoreServiceStatus,
  SubscriptionPlan,
  SubscriptionStatus,
} from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { AuthTokenPayload } from '../auth/strategies/jwt.strategy';
import { PosAccessService } from '../common/pos-access.service';
import { PrismaService } from '../prisma.service';

type AuditRecorder = {
  record: (...args: Parameters<AuditService['record']>) => Promise<unknown>;
};

const NOOP_AUDIT: AuditRecorder = { record: () => Promise.resolve(null) };

@Injectable()
export class StoreService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: PosAccessService,
    @Optional()
    private readonly audit: AuditService = NOOP_AUDIT as unknown as AuditService,
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

    const store = await this.prisma.$transaction(async (tx) => {
      const created = await tx.store.create({
        data: {
          name: dto.name,
          address: dto.address,
          businessType: dto.businessType,
          ownerId: user.accountId,
          isActive: false,
          features: {
            create: this.includedFeatureKeys.map((feature) => ({
              feature,
              enabled: dto.features.includes(feature),
              source: StoreFeatureSource.setup,
            })),
          },
        },
        include: this.storeInclude,
      });

      await this.audit.record(tx, {
        storeId: created.id,
        actorId: user.staffId,
        ownerId: user.accountId,
        action: AuditAction.create,
        entityType: AuditEntityType.store,
        entityId: created.id,
        entityName: created.name,
        summary: `Created store ${created.name}`,
        after: created,
      });

      return created;
    });

    return this.serializeStore(store);
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
        const existing = await tx.store.findUnique({
          where: { id: store.id },
          include: this.storeInclude,
        });

        return existing ? this.serializeStore(existing) : existing;
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
      await this.audit.record(tx, {
        storeId: store.id,
        actorId: user.staffId,
        ownerId: user.accountId,
        action: AuditAction.activate,
        entityType: AuditEntityType.store,
        entityId: store.id,
        entityName: activatedStore.name,
        summary: `Activated store ${activatedStore.name}`,
        before: store,
        after: activatedStore,
      });

      return this.serializeStore(activatedStore);
    });
  }

  async update(
    storeId: string,
    body: Record<string, unknown>,
    user: AuthTokenPayload,
  ) {
    await this.assertCanManageStore(user, storeId);
    const updates = this.parseUpdateBody(body);

    const store = await this.prisma.$transaction(async (tx) => {
      const before = await tx.store.findUnique({ where: { id: storeId } });
      const updated = await tx.store.update({
        where: { id: storeId },
        data: updates,
        include: this.storeInclude,
      });

      await this.audit.record(tx, {
        storeId,
        actorId: user.staffId,
        ownerId: user.type === StaffRole.owner ? user.accountId : null,
        action: AuditAction.update,
        entityType: AuditEntityType.store,
        entityId: storeId,
        entityName: updated.name,
        summary: `Updated store ${updated.name}`,
        before,
        after: updated,
      });

      return updated;
    });

    return this.serializeStore(store);
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
      await this.audit.record(tx, {
        storeId,
        actorId: user.staffId,
        ownerId: store.ownerId,
        action: AuditAction.deactivate,
        entityType: AuditEntityType.store,
        entityId: storeId,
        entityName: deletedStore.name,
        summary: `Deactivated store ${deletedStore.name}`,
        before: store,
        after: deletedStore,
      });

      return this.serializeStore(deletedStore);
    });
  }

  async myStores(user: AuthTokenPayload, includeInactive = false) {
    let stores: StoreWithEntitlements[];

    if (user.type === StaffRole.owner) {
      stores = await this.prisma.store.findMany({
        where: {
          ownerId: user.accountId,
          ...(includeInactive ? {} : { isActive: true }),
        },
        orderBy: { createdAt: 'desc' },
        include: this.storeInclude,
      });
    } else {
      stores = await this.prisma.store.findMany({
        where: {
          isActive: true,
          staff: { some: { staffId: user.staffId } },
        },
        orderBy: { createdAt: 'desc' },
        include: this.storeInclude,
      });
    }

    return stores.map((store) => this.serializeStore(store));
  }

  async findOne(storeId: string, user: AuthTokenPayload) {
    await this.access.ensureStoreAccess(storeId, user, 'view_store');

    const store = await this.prisma.store.findFirst({
      where: { id: storeId, isActive: true },
      include: this.storeInclude,
    });

    return store ? this.serializeStore(store) : store;
  }

  async getFeatures(storeId: string, user: AuthTokenPayload) {
    await this.access.ensureStoreAccess(storeId, user, 'view_store');
    const store = await this.prisma.store.findUnique({
      where: { id: storeId },
      include: this.storeEntitlementInclude,
    });

    if (!store) {
      throw new NotFoundException('Store not found');
    }

    return this.serializeCapabilities(store);
  }

  async updateFeatures(
    storeId: string,
    body: Record<string, unknown>,
    user: AuthTokenPayload,
  ) {
    await this.assertStoreOwner(
      storeId,
      user,
      'Only owners can manage store features',
    );
    const updates = this.parseFeaturePatchBody(body);

    if (!Object.keys(updates).length) {
      throw new BadRequestException(
        'At least one included store feature is required',
      );
    }

    const store = await this.prisma.$transaction(async (tx) => {
      await Promise.all(
        Object.entries(updates).map(([feature, enabled]) =>
          tx.storeFeature.upsert({
            where: {
              storeId_feature: {
                storeId,
                feature: feature as StoreFeatureKey,
              },
            },
            create: {
              storeId,
              feature: feature as StoreFeatureKey,
              enabled,
              source: StoreFeatureSource.manual,
            },
            update: {
              enabled,
              source: StoreFeatureSource.manual,
            },
          }),
        ),
      );

      const updatedStore = await tx.store.findUnique({
        where: { id: storeId },
        include: this.storeEntitlementInclude,
      });

      await this.audit.record(tx, {
        storeId,
        actorId: user.staffId,
        ownerId: user.accountId,
        action: AuditAction.update,
        entityType: AuditEntityType.store_feature,
        entityId: storeId,
        entityName: updatedStore?.id ?? storeId,
        summary: 'Updated store features',
        after: updatedStore,
        metadata: updates,
      });

      return updatedStore;
    });

    if (!store) {
      throw new NotFoundException('Store not found');
    }

    return this.serializeCapabilities(store);
  }

  private parseCreateBody(body: Record<string, unknown>) {
    const features = this.parseFeatureSelection(body);

    return {
      name: this.requiredString(body.name, 'name'),
      address: this.optionalString(body.address, 'address'),
      businessType: this.requiredBusinessType(body.businessType),
      features,
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

  private parseFeatureSelection(body: Record<string, unknown>) {
    const selected = new Set<StoreFeatureKey>();

    if (Array.isArray(body.features)) {
      for (const value of body.features) {
        selected.add(this.requiredIncludedFeatureKey(value));
      }
    }

    if (body.lotteryEnabled !== undefined) {
      this.addBooleanFeature(
        selected,
        StoreFeatureKey.lottery,
        body.lotteryEnabled,
        'lotteryEnabled',
      );
    }

    if (body.recipeSuiteEnabled !== undefined) {
      this.addBooleanFeature(
        selected,
        StoreFeatureKey.recipe_suite,
        body.recipeSuiteEnabled,
        'recipeSuiteEnabled',
      );
    }

    return [...selected];
  }

  private parseFeaturePatchBody(body: Record<string, unknown>) {
    const updates: Partial<Record<StoreFeatureKey, boolean>> = {};

    if (body.features !== undefined) {
      throw new BadRequestException(
        'features array is only supported during store creation',
      );
    }

    if (body.loyalty !== undefined || body.loyaltyEnabled !== undefined) {
      throw new BadRequestException(
        'Loyalty is managed by the billing service subscription',
      );
    }

    if (body.lottery !== undefined) {
      updates[StoreFeatureKey.lottery] = this.requiredBoolean(
        body.lottery,
        'lottery',
      );
    }

    if (body.recipeSuite !== undefined) {
      updates[StoreFeatureKey.recipe_suite] = this.requiredBoolean(
        body.recipeSuite,
        'recipeSuite',
      );
    }

    if (body.lotteryEnabled !== undefined) {
      updates[StoreFeatureKey.lottery] = this.requiredBoolean(
        body.lotteryEnabled,
        'lotteryEnabled',
      );
    }

    if (body.recipeSuiteEnabled !== undefined) {
      updates[StoreFeatureKey.recipe_suite] = this.requiredBoolean(
        body.recipeSuiteEnabled,
        'recipeSuiteEnabled',
      );
    }

    for (const key of Object.keys(body)) {
      if (!this.allowedFeaturePatchKeys.has(key)) {
        throw new BadRequestException(`Unknown store feature key: ${key}`);
      }
    }

    return updates;
  }

  private addBooleanFeature(
    selected: Set<StoreFeatureKey>,
    feature: StoreFeatureKey,
    value: unknown,
    field: string,
  ) {
    if (this.requiredBoolean(value, field)) {
      selected.add(feature);
    } else {
      selected.delete(feature);
    }
  }

  private requiredIncludedFeatureKey(value: unknown) {
    if (value === StoreFeatureKey.lottery || value === 'lottery') {
      return StoreFeatureKey.lottery;
    }

    if (value === StoreFeatureKey.recipe_suite || value === 'recipe_suite') {
      return StoreFeatureKey.recipe_suite;
    }

    if (value === StoreFeatureKey.loyalty || value === 'loyalty') {
      throw new BadRequestException(
        'Loyalty cannot be enabled during store setup',
      );
    }

    throw new BadRequestException(`Unknown store feature: ${String(value)}`);
  }

  private requiredBoolean(value: unknown, field: string) {
    if (typeof value !== 'boolean') {
      throw new BadRequestException(`${field} must be a boolean`);
    }

    return value;
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

  private async assertStoreOwner(
    storeId: string,
    user: AuthTokenPayload,
    message: string,
  ) {
    if (user.type !== StaffRole.owner) {
      throw new ForbiddenException(message);
    }

    const store = await this.prisma.store.findUnique({
      where: { id: storeId },
      select: { ownerId: true },
    });

    if (!store) {
      throw new NotFoundException('Store not found');
    }

    if (store.ownerId !== user.accountId) {
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

  private serializeStore(store: StoreWithEntitlements) {
    return {
      ...store,
      capabilities: this.serializeCapabilities(store).features,
    };
  }

  private serializeCapabilities(store: StoreEntitlementState) {
    const features = Array.isArray(store.features) ? store.features : [];
    const serviceSubscriptions = Array.isArray(store.serviceSubscriptions)
      ? store.serviceSubscriptions
      : [];
    const featureMap = new Map(
      features.map((feature) => [feature.feature, feature]),
    );
    const serviceMap = new Map(
      serviceSubscriptions.map((service) => [service.service, service]),
    );
    const lottery = featureMap.get(StoreFeatureKey.lottery);
    const recipeSuite = featureMap.get(StoreFeatureKey.recipe_suite);
    const loyaltyService = serviceMap.get(StoreServiceKey.loyalty);
    const loyaltyEnabled = Boolean(
      loyaltyService && this.isActiveServiceStatus(loyaltyService.status),
    );
    const vendorOrders = featureMap.get(StoreFeatureKey.vendor_orders);

    return {
      storeId: store.id,
      features: {
        lottery: {
          enabled: lottery?.enabled === true,
          available: lottery?.enabled === true,
          source: lottery?.source ?? StoreFeatureSource.setup,
        },
        recipeSuite: {
          enabled: recipeSuite?.enabled === true,
          available: recipeSuite?.enabled === true,
          source: recipeSuite?.source ?? StoreFeatureSource.setup,
        },
        orders: {
          enabled: vendorOrders?.enabled === true,
          available: vendorOrders?.enabled === true,
          source: vendorOrders?.source ?? StoreFeatureSource.subscription,
        },
        loyalty: {
          enabled: loyaltyEnabled,
          available: loyaltyEnabled,
          source: StoreFeatureSource.subscription,
          billingStatus: loyaltyService?.status ?? StoreServiceStatus.not_added,
        },
      },
    };
  }

  private isActiveServiceStatus(status: StoreServiceStatus) {
    return status === StoreServiceStatus.active;
  }

  private readonly includedFeatureKeys = [
    StoreFeatureKey.lottery,
    StoreFeatureKey.recipe_suite,
  ];

  private readonly allowedFeaturePatchKeys = new Set([
    'lottery',
    'recipeSuite',
    'lotteryEnabled',
    'recipeSuiteEnabled',
    'loyalty',
    'loyaltyEnabled',
  ]);

  private readonly storeEntitlementInclude = {
    features: true,
    serviceSubscriptions: true,
  } satisfies Prisma.StoreInclude;

  private readonly storeInclude = {
    departments: true,
    priceGroups: true,
    productCategories: true,
    taxes: true,
    products: true,
    staff: true,
    features: true,
    serviceSubscriptions: true,
  } satisfies Prisma.StoreInclude;
}

type StoreEntitlementState = Prisma.StoreGetPayload<{
  include: {
    features: true;
    serviceSubscriptions: true;
  };
}>;

type StoreWithEntitlements = Prisma.StoreGetPayload<{
  include: {
    departments: true;
    priceGroups: true;
    productCategories: true;
    taxes: true;
    products: true;
    staff: true;
    features: true;
    serviceSubscriptions: true;
  };
}>;
