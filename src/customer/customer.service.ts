import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { CustomerTierDiscountModel, Prisma, StaffRole } from '@prisma/client';
import { randomInt } from 'crypto';
import { AuthTokenPayload } from '../auth/strategies/jwt.strategy';
import { PosAccessService, StorePermission } from '../common/pos-access.service';
import { PrismaService } from '../prisma.service';

@Injectable()
export class CustomerService {
  private readonly purchaseHistoryDays = 60;

  constructor(
    private readonly prisma: PrismaService,
    private readonly access: PosAccessService,
  ) {}

  async create(body: Record<string, unknown>, user: AuthTokenPayload) {
    const dto = this.parseCreateCustomerBody(body);
    const store = await this.ensureStoreAccess(
      dto.storeId,
      user,
      'manage_customers',
    );
    const customerNumber = await this.generateUniqueCustomerNumber();

    try {
      const customer = await this.prisma.customer.create({
        data: {
          customerNumber,
          email: dto.email,
          firstName: dto.firstName,
          lastName: dto.lastName,
          phone: dto.phone,
          stores: {
            create: {
              storeId: store.id,
            },
          },
        },
        include: this.customerInclude,
      });

      return this.toCustomerResponse(customer, [store.id]);
    } catch (error) {
      if (this.isUniqueConstraintError(error, 'phone')) {
        throw new ConflictException(
          'A customer with that phone already exists',
        );
      }

      if (this.isUniqueConstraintError(error, 'customerNumber')) {
        throw new ConflictException(
          'Unable to generate a unique customer number',
        );
      }

      throw error;
    }
  }

  async findByCustomerNumber(customerNumber: string, user: AuthTokenPayload) {
    const customer = await this.prisma.customer.findUnique({
      where: { customerNumber },
      include: this.customerInclude,
    });

    if (!customer) {
      throw new NotFoundException('Customer not found');
    }

    const accessibleStoreIds = await this.ensureCustomerAccess(
      customer.id,
      user,
    );

    return this.toCustomerResponse(customer, accessibleStoreIds);
  }

  async findByPhone(phone: string, user: AuthTokenPayload) {
    const customer = await this.prisma.customer.findUnique({
      where: { phone: this.requiredString(phone, 'phone') },
      include: this.customerInclude,
    });

    if (!customer) {
      throw new NotFoundException('Customer not found');
    }

    const accessibleStoreIds = await this.ensureCustomerAccess(
      customer.id,
      user,
    );

    return this.toCustomerResponse(customer, accessibleStoreIds);
  }

  async listByStore(storeId: string, user: AuthTokenPayload) {
    await this.ensureStoreAccess(storeId, user);

    const customerStores = await this.prisma.customerStore.findMany({
      where: { storeId },
      orderBy: { createdAt: 'desc' },
      include: {
        currentTierRule: true,
        customer: {
          include: this.customerInclude,
        },
      },
    });

    return customerStores.map((customerStore) =>
      this.toCustomerResponse(customerStore.customer, [storeId]),
    );
  }

  async update(
    id: string,
    body: Record<string, unknown>,
    user: AuthTokenPayload,
  ) {
    const accessibleStoreIds = await this.ensureCustomerAccess(
      id,
      user,
      'manage_customers',
    );
    const updates = this.parseUpdateCustomerBody(body);

    if (!Object.keys(updates).length) {
      const customer = await this.findCustomerByIdOrThrow(id);
      return this.toCustomerResponse(customer, accessibleStoreIds);
    }

    try {
      const customer = await this.prisma.customer.update({
        where: { id },
        data: updates,
        include: this.customerInclude,
      });

      return this.toCustomerResponse(customer, accessibleStoreIds);
    } catch (error) {
      if (this.isUniqueConstraintError(error, 'phone')) {
        throw new ConflictException(
          'A customer with that phone already exists',
        );
      }

      throw error;
    }
  }

  async createTier(body: Record<string, unknown>, user: AuthTokenPayload) {
    const dto = this.parseCreateTierBody(body);
    const store = await this.ensureStoreAccess(
      dto.storeId,
      user,
      'manage_customers',
    );

    if (user.type !== 'owner' || user.accountId !== store.ownerId) {
      throw new ForbiddenException('Only the store owner can manage tiers');
    }

    try {
      const tier = await this.prisma.customerTier.create({
        data: {
          name: dto.name,
          discountModel: dto.discountModel,
          discountValue: dto.discountValue,
          ownerId: store.ownerId,
          storeId: store.id,
        },
      });

      return this.toTierResponse(tier);
    } catch (error) {
      if (this.isUniqueConstraintError(error, 'storeId')) {
        throw new ConflictException('A tier with that name already exists');
      }

      throw error;
    }
  }

  async createTierRule(body: Record<string, unknown>, user: AuthTokenPayload) {
    const dto = this.parseCreateTierRuleBody(body);
    const store = await this.ensureStoreAccess(
      dto.storeId,
      user,
      'manage_customers',
    );

    if (user.type !== 'owner' || user.accountId !== store.ownerId) {
      throw new ForbiddenException(
        'Only the store owner can manage tier rules',
      );
    }

    const tier = dto.tierId
      ? await this.findTierForStoreOrThrow(dto.tierId, store.id)
      : null;
    const ruleName = dto.name ?? tier?.name;

    if (!ruleName) {
      throw new BadRequestException('name or tierId is required');
    }

    const tierRule = await this.prisma.customerTierRule.create({
      data: {
        name: ruleName,
        minimumSpend: dto.minimumSpend,
        syncAcrossOwnerStores: dto.syncAcrossOwnerStores,
        ownerId: store.ownerId,
        storeId: store.id,
        tierId: tier?.id,
      },
      include: { tier: true },
    });

    return this.toTierRuleResponse(tierRule);
  }

  async getPurchases(id: string, user: AuthTokenPayload) {
    const accessibleStoreIds = await this.ensureCustomerAccess(id, user);
    const since = this.getPurchaseHistoryCutoff();

    const purchases = await this.prisma.customerPurchaseHistory.findMany({
      where: {
        customerId: id,
        storeId: { in: accessibleStoreIds },
        purchasedAt: { gte: since },
      },
      orderBy: { purchasedAt: 'desc' },
    });

    return purchases.map((purchase) => ({
      id: purchase.id,
      storeId: purchase.storeId,
      transactionId: purchase.transactionId,
      totalSpend: purchase.totalSpend.toString(),
      purchasedAt: purchase.purchasedAt,
    }));
  }

  async recalculateCustomerTier(
    id: string,
    body: Record<string, unknown>,
    user: AuthTokenPayload,
  ) {
    const storeId = this.optionalString(body.storeId, 'storeId');

    if (storeId) {
      await this.ensureStoreAccess(storeId, user, 'manage_customers');
    }

    const customerStore = await this.findCustomerStoreForTierUpdate(
      id,
      storeId,
      user,
    );
    const tierResult = await this.findBestTierRule(
      customerStore.customerId,
      customerStore.storeId,
    );
    const tierRule = tierResult.tierRule;

    const updated = await this.prisma.$transaction(async (tx) => {
      if (tierRule?.syncAcrossOwnerStores) {
        await tx.customerStore.updateMany({
          where: {
            customerId: customerStore.customerId,
            store: { ownerId: tierResult.ownerId },
          },
          data: {
            tier: this.getTierName(tierRule),
            currentTierRuleId: tierRule.id,
            currentTierId: tierRule.tierId,
          },
        });
      } else {
        await tx.customerStore.update({
          where: { id: customerStore.id },
          data: {
            tier: tierRule ? this.getTierName(tierRule) : null,
            currentTierRuleId: tierRule?.id ?? null,
            currentTierId: tierRule?.tierId ?? null,
          },
        });
      }

      return tx.customer.update({
        where: { id: customerStore.customerId },
        data: {
          tier: tierRule?.syncAcrossOwnerStores
            ? this.getTierName(tierRule)
            : undefined,
        },
        include: this.customerInclude,
      });
    });

    const accessibleStoreIds = await this.ensureCustomerAccess(
      updated.id,
      user,
    );

    return this.toCustomerResponse(updated, accessibleStoreIds);
  }

  recalculateWeeklyCustomerTiers() {
    return {
      message:
        'Weekly customer tier recalculation placeholder. Wire this method to a scheduler when automation is added.',
    };
  }

  private async findBestTierRule(customerId: string, storeId: string) {
    const store = await this.prisma.store.findUnique({
      where: { id: storeId },
      select: { ownerId: true },
    });

    if (!store) {
      throw new NotFoundException('Store not found');
    }

    const since = this.getPurchaseHistoryCutoff();
    const [storeSpendResult, ownerSpendResult] = await Promise.all([
      this.prisma.customerPurchaseHistory.aggregate({
        where: {
          customerId,
          storeId,
          purchasedAt: { gte: since },
        },
        _sum: {
          totalSpend: true,
        },
      }),
      this.prisma.customerPurchaseHistory.aggregate({
        where: {
          customerId,
          store: { ownerId: store.ownerId },
          purchasedAt: { gte: since },
        },
        _sum: {
          totalSpend: true,
        },
      }),
    ]);
    const storeSpend =
      storeSpendResult._sum.totalSpend ?? new Prisma.Decimal(0);
    const ownerSpend =
      ownerSpendResult._sum.totalSpend ?? new Prisma.Decimal(0);

    const [storeRule, ownerRule] = await Promise.all([
      this.prisma.customerTierRule.findFirst({
        where: {
          isActive: true,
          storeId,
          syncAcrossOwnerStores: false,
          minimumSpend: { lte: storeSpend },
        },
        orderBy: { minimumSpend: 'desc' },
        include: { tier: true },
      }),
      this.prisma.customerTierRule.findFirst({
        where: {
          isActive: true,
          ownerId: store.ownerId,
          syncAcrossOwnerStores: true,
          minimumSpend: { lte: ownerSpend },
        },
        orderBy: { minimumSpend: 'desc' },
        include: { tier: true },
      }),
    ]);

    if (
      ownerRule &&
      (!storeRule || ownerRule.minimumSpend.greaterThan(storeRule.minimumSpend))
    ) {
      return {
        tierRule: ownerRule,
        ownerId: store.ownerId,
      };
    }

    return {
      tierRule: storeRule,
      ownerId: store.ownerId,
    };
  }

  private async findCustomerStoreForTierUpdate(
    customerId: string,
    storeId: string | null | undefined,
    user: AuthTokenPayload,
  ) {
    const customerStores = await this.prisma.customerStore.findMany({
      where: {
        customerId,
        storeId: storeId ?? undefined,
      },
      include: { store: true },
      orderBy: { createdAt: 'asc' },
    });

    if (!customerStores.length) {
      throw new NotFoundException('Customer not found for accessible store');
    }

    for (const customerStore of customerStores) {
      if (await this.canAccessStore(customerStore.store, user)) {
        return customerStore;
      }
    }

    throw new ForbiddenException('You do not have access to this customer');
  }

  private async findTierForStoreOrThrow(tierId: string, storeId: string) {
    const tier = await this.prisma.customerTier.findFirst({
      where: {
        id: tierId,
        storeId,
        isActive: true,
      },
    });

    if (!tier) {
      throw new NotFoundException('Tier not found for this store');
    }

    return tier;
  }

  private async ensureCustomerAccess(
    customerId: string,
    user: AuthTokenPayload,
    permission: StorePermission = 'view_store',
  ) {
    const customerStores = await this.prisma.customerStore.findMany({
      where: { customerId },
      include: { store: true },
    });

    if (!customerStores.length) {
      throw new NotFoundException('Customer not found');
    }

    const accessibleStoreIds: string[] = [];

    for (const customerStore of customerStores) {
      if (await this.canAccessStore(customerStore.store, user, permission)) {
        accessibleStoreIds.push(customerStore.storeId);
      }
    }

    if (!accessibleStoreIds.length) {
      throw new ForbiddenException('You do not have access to this customer');
    }

    return accessibleStoreIds;
  }

  private async ensureStoreAccess(
    storeId: string,
    user: AuthTokenPayload,
    permission: StorePermission = 'view_store',
  ) {
    return this.access.ensureStoreAccess(
      this.requiredString(storeId, 'storeId'),
      user,
      permission,
    );
  }

  private async canAccessStore(
    store: { id: string; ownerId: string; isActive?: boolean },
    user: AuthTokenPayload,
    permission: StorePermission = 'view_store',
  ) {
    if (store.isActive === false) {
      return false;
    }

    if (user.type === StaffRole.owner && user.accountId === store.ownerId) {
      return true;
    }

    try {
      await this.access.ensureStoreAccess(store.id, user, permission);
      return true;
    } catch {
      return false;
    }
  }

  private async findCustomerByIdOrThrow(id: string) {
    const customer = await this.prisma.customer.findUnique({
      where: { id },
      include: this.customerInclude,
    });

    if (!customer) {
      throw new NotFoundException('Customer not found');
    }

    return customer;
  }

  private async generateUniqueCustomerNumber() {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const customerNumber = this.generateCustomerNumber();
      const existing = await this.prisma.customer.findUnique({
        where: { customerNumber },
        select: { id: true },
      });

      if (!existing) {
        return customerNumber;
      }
    }

    throw new ConflictException('Unable to generate a unique customer number');
  }

  private generateCustomerNumber() {
    let value = '';

    while (value.length < 18) {
      value += randomInt(0, 10).toString();
    }

    return value;
  }

  private parseCreateCustomerBody(body: Record<string, unknown>) {
    return {
      firstName: this.requiredString(body.firstName, 'firstName'),
      lastName: this.requiredString(body.lastName, 'lastName'),
      phone: this.requiredString(body.phone, 'phone'),
      storeId: this.requiredString(body.storeId, 'storeId'),
      email: this.optionalString(body.email, 'email'),
    };
  }

  private parseUpdateCustomerBody(body: Record<string, unknown>) {
    const updates: Prisma.CustomerUpdateInput = {};

    if (body.firstName !== undefined) {
      updates.firstName = this.requiredString(body.firstName, 'firstName');
    }

    if (body.lastName !== undefined) {
      updates.lastName = this.requiredString(body.lastName, 'lastName');
    }

    if (body.email !== undefined) {
      updates.email = this.optionalString(body.email, 'email');
    }

    if (body.phone !== undefined) {
      updates.phone = this.requiredString(body.phone, 'phone');
    }

    return updates;
  }

  private parseCreateTierBody(body: Record<string, unknown>) {
    const discountModel = this.requiredDiscountModel(
      body.discountModel,
      'discountModel',
    );
    const discountValue = this.requiredDecimal(
      body.discountValue,
      'discountValue',
    );

    this.validateDiscountValue(discountModel, discountValue);

    return {
      storeId: this.requiredString(body.storeId, 'storeId'),
      name: this.requiredString(body.name, 'name'),
      discountModel,
      discountValue,
    };
  }

  private parseCreateTierRuleBody(body: Record<string, unknown>) {
    const tierId = this.optionalString(body.tierId, 'tierId');
    const name = this.optionalString(body.name, 'name');

    if (!tierId && !name) {
      throw new BadRequestException('name or tierId is required');
    }

    return {
      storeId: this.requiredString(body.storeId, 'storeId'),
      tierId,
      name,
      minimumSpend: this.requiredDecimal(body.minimumSpend, 'minimumSpend'),
      syncAcrossOwnerStores: this.optionalBoolean(
        body.syncAcrossOwnerStores,
        'syncAcrossOwnerStores',
      ),
    };
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

  private optionalBoolean(value: unknown, field: string) {
    if (value === undefined || value === null) {
      return false;
    }

    if (typeof value !== 'boolean') {
      throw new BadRequestException(`${field} must be a boolean`);
    }

    return value;
  }

  private requiredDiscountModel(value: unknown, field: string) {
    if (typeof value !== 'string' || !value.trim()) {
      throw new BadRequestException(`${field} is required`);
    }

    if (
      !Object.values(CustomerTierDiscountModel).includes(
        value as CustomerTierDiscountModel,
      )
    ) {
      throw new BadRequestException(
        `${field} must be one of ${Object.values(
          CustomerTierDiscountModel,
        ).join(', ')}`,
      );
    }

    return value as CustomerTierDiscountModel;
  }

  private requiredDecimal(value: unknown, field: string) {
    if (typeof value !== 'number' && typeof value !== 'string') {
      throw new BadRequestException(`${field} is required`);
    }

    const decimal = new Prisma.Decimal(value);

    if (decimal.isNegative()) {
      throw new BadRequestException(`${field} must be zero or greater`);
    }

    return decimal;
  }

  private validateDiscountValue(
    discountModel: CustomerTierDiscountModel,
    discountValue: Prisma.Decimal,
  ) {
    if (
      (discountModel === CustomerTierDiscountModel.ORDER_PERCENTAGE ||
        discountModel === CustomerTierDiscountModel.ITEM_PERCENTAGE) &&
      discountValue.greaterThan(100)
    ) {
      throw new BadRequestException(
        'percentage discountValue cannot exceed 100',
      );
    }
  }

  private getPurchaseHistoryCutoff() {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - this.purchaseHistoryDays);

    return cutoff;
  }

  private toCustomerResponse(
    customer: CustomerWithRelations,
    accessibleStoreIds: string[],
  ) {
    const accessibleStoreIdSet = new Set(accessibleStoreIds);

    return {
      id: customer.id,
      customerNumber: customer.customerNumber,
      email: customer.email,
      firstName: customer.firstName,
      lastName: customer.lastName,
      phone: customer.phone,
      rewardPoints: customer.rewardPoints,
      tier: customer.tier,
      stores: customer.stores
        .filter((store) => accessibleStoreIdSet.has(store.storeId))
        .map((store) => ({
          storeId: store.storeId,
          tier: store.tier,
          currentTierRule: store.currentTierRule
            ? this.toTierRuleResponse(store.currentTierRule)
            : null,
          currentTier: store.currentTier
            ? this.toTierResponse(store.currentTier)
            : null,
        })),
      createdAt: customer.createdAt,
      updatedAt: customer.updatedAt,
    };
  }

  private toTierRuleResponse(tierRule: CustomerTierRuleResponse) {
    return {
      id: tierRule.id,
      ownerId: tierRule.ownerId,
      storeId: tierRule.storeId,
      name: tierRule.name,
      tierId: tierRule.tierId,
      tier:
        'tier' in tierRule && tierRule.tier
          ? this.toTierResponse(tierRule.tier)
          : null,
      minimumSpend: tierRule.minimumSpend.toString(),
      syncAcrossOwnerStores: tierRule.syncAcrossOwnerStores,
      isActive: tierRule.isActive,
      createdAt: tierRule.createdAt,
      updatedAt: tierRule.updatedAt,
    };
  }

  private toTierResponse(tier: CustomerTierResponse) {
    return {
      id: tier.id,
      ownerId: tier.ownerId,
      storeId: tier.storeId,
      name: tier.name,
      discountModel: tier.discountModel,
      discountValue: tier.discountValue.toString(),
      isActive: tier.isActive,
      createdAt: tier.createdAt,
      updatedAt: tier.updatedAt,
    };
  }

  private getTierName(tierRule: CustomerTierRuleResponse) {
    return 'tier' in tierRule && tierRule.tier
      ? tierRule.tier.name
      : tierRule.name;
  }

  private isUniqueConstraintError(error: unknown, field: string) {
    return (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002' &&
      Array.isArray(error.meta?.target) &&
      error.meta.target.includes(field)
    );
  }

  private readonly customerInclude = {
    stores: {
      include: {
        currentTier: true,
        currentTierRule: {
          include: {
            tier: true,
          },
        },
      },
    },
  } satisfies Prisma.CustomerInclude;
}

type CustomerWithRelations = Prisma.CustomerGetPayload<{
  include: {
    stores: {
      include: {
        currentTier: true;
        currentTierRule: {
          include: {
            tier: true;
          };
        };
      };
    };
  };
}>;

type CustomerTierResponse = Prisma.CustomerTierGetPayload<object>;

type CustomerTierRuleResponse =
  | Prisma.CustomerTierRuleGetPayload<object>
  | Prisma.CustomerTierRuleGetPayload<{ include: { tier: true } }>;
