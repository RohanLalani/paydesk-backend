import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  AuditAction,
  AuditEntityType,
  Prisma,
  PromotionConflictStrategy,
  PromotionProductRole,
  PromotionStatus,
  PromotionType,
  StorePermissionKey,
} from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { AuthTokenPayload } from '../auth/strategies/jwt.strategy';
import { PosAccessService } from '../common/pos-access.service';
import { PrismaService } from '../prisma.service';
import { PromotionEvaluationService } from './promotion-evaluation.service';
import {
  EvaluationInput,
  PromotionConfiguration,
  PromotionInput,
  STATUS_VALUES,
  STRATEGY_VALUES,
  TYPE_VALUES,
} from './promotion.types';

const INCLUDE = {
  products: {
    include: {
      product: {
        select: {
          id: true,
          productNumber: true,
          barcode: true,
          name: true,
          unitCost: true,
          unitRetail: true,
          currentQuantity: true,
          isActive: true,
          department: { select: { id: true, name: true } },
          productCategory: { select: { id: true, name: true } },
          priceGroup: { select: { id: true, name: true } },
        },
      },
    },
  },
} as const;

@Injectable()
export class PromotionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: PosAccessService,
    private readonly audit: AuditService,
    private readonly evaluator: PromotionEvaluationService,
  ) {}

  async list(
    storeId: string,
    query: Record<string, unknown>,
    user: AuthTokenPayload,
  ) {
    await this.ensureView(storeId, user);
    const page = this.positive(query.page, 'page', 1);
    const limit = Math.min(this.positive(query.limit, 'limit', 25), 100);
    const now = new Date();
    const where: Prisma.PromotionWhereInput = { storeId };
    if (typeof query.search === 'string' && query.search.trim())
      where.OR = [
        { name: { contains: query.search.trim(), mode: 'insensitive' } },
        { description: { contains: query.search.trim(), mode: 'insensitive' } },
      ];
    if (
      typeof query.type === 'string' &&
      TYPE_VALUES.includes(query.type as PromotionType)
    )
      where.type = query.type as PromotionType;
    if (
      typeof query.status === 'string' &&
      STATUS_VALUES.includes(query.status as PromotionStatus)
    )
      where.status = query.status as PromotionStatus;
    if (typeof query.productId === 'string' && query.productId)
      where.products = { some: { productId: query.productId } };
    if (query.stackable === 'true' || query.stackable === 'false')
      where.stackable = query.stackable === 'true';
    if (query.activeNow === 'true')
      Object.assign(where, {
        status: { in: [PromotionStatus.ACTIVE, PromotionStatus.SCHEDULED] },
        startAt: { lte: now },
        OR: [{ endAt: null }, { endAt: { gt: now } }],
      });
    const sort =
      typeof query.sort === 'string' &&
      [
        'name',
        'type',
        'status',
        'startAt',
        'endAt',
        'priority',
        'updatedAt',
      ].includes(query.sort)
        ? query.sort
        : 'updatedAt';
    const order = query.order === 'asc' ? 'asc' : 'desc';
    const [items, total] = await Promise.all([
      this.prisma.promotion.findMany({
        where,
        include: { _count: { select: { products: true } } },
        orderBy: { [sort]: order },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.promotion.count({ where }),
    ]);
    const mapped = items.map((item) => ({
      ...item,
      effectiveStatus: this.effectiveStatus(
        item.status,
        item.startAt,
        item.endAt,
        now,
      ),
      productCount: item._count.products,
    }));
    mapped.sort(
      (a, b) =>
        this.statusRank(a.effectiveStatus) -
          this.statusRank(b.effectiveStatus) ||
        b.updatedAt.getTime() - a.updatedAt.getTime(),
    );
    return {
      items: mapped,
      total,
      page,
      limit,
      totalPages: Math.max(1, Math.ceil(total / limit)),
    };
  }

  async get(storeId: string, id: string, user: AuthTokenPayload) {
    await this.ensureView(storeId, user);
    return this.find(storeId, id);
  }

  async productSearch(
    storeId: string,
    query: Record<string, unknown>,
    user: AuthTokenPayload,
  ) {
    await this.ensureView(storeId, user);
    const page = this.positive(query.page, 'page', 1);
    const limit = Math.min(this.positive(query.limit, 'limit', 25), 100);
    const search = typeof query.search === 'string' ? query.search.trim() : '';
    const numeric = Number(search);
    const where: Prisma.ProductWhereInput = {
      storeId,
      ...(query.active === 'true' ? { isActive: true } : {}),
      ...(search
        ? {
            OR: [
              { barcode: { contains: search, mode: 'insensitive' } },
              { name: { contains: search, mode: 'insensitive' } },
              { nacsCode: { contains: search, mode: 'insensitive' } },
              { nacsCategory: { contains: search, mode: 'insensitive' } },
              { nacsSubCategory: { contains: search, mode: 'insensitive' } },
              {
                department: { name: { contains: search, mode: 'insensitive' } },
              },
              {
                productCategory: {
                  name: { contains: search, mode: 'insensitive' },
                },
              },
              {
                priceGroup: { name: { contains: search, mode: 'insensitive' } },
              },
              ...(Number.isInteger(numeric)
                ? [{ productNumber: numeric }]
                : []),
            ],
          }
        : {}),
    };
    const select = {
      id: true,
      productNumber: true,
      barcode: true,
      name: true,
      saleType: true,
      unitCost: true,
      unitRetail: true,
      currentQuantity: true,
      isActive: true,
      nacsCode: true,
      nacsCategory: true,
      nacsSubCategory: true,
      department: { select: { id: true, name: true } },
      productCategory: { select: { id: true, name: true } },
      priceGroup: { select: { id: true, name: true } },
    } as const;
    const [items, total] = await Promise.all([
      this.prisma.product.findMany({
        where,
        select,
        orderBy: { productNumber: 'asc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.product.count({ where }),
    ]);
    return {
      items,
      total,
      page,
      limit,
      totalPages: Math.max(1, Math.ceil(total / limit)),
    };
  }

  async create(storeId: string, input: PromotionInput, user: AuthTokenPayload) {
    await this.access.ensureStoreAccess(
      storeId,
      user,
      StorePermissionKey.manage_promotions,
    );
    const parsed = await this.parse(storeId, input, false);
    return this.prisma.$transaction(async (tx) => {
      const promotion = await tx.promotion.create({
        data: {
          ...parsed.data,
          storeId,
          createdByActorId: user.staffId,
          updatedByActorId: user.staffId,
          products: { create: parsed.assignments },
        },
        include: INCLUDE,
      });
      await this.audit.record(tx, {
        storeId,
        actorId: user.staffId,
        action: AuditAction.create,
        entityType: AuditEntityType.promotion,
        entityId: promotion.id,
        entityName: promotion.name,
        summary: `Promotion ${promotion.name} created`,
        after: promotion,
        metadata: this.assignmentSummary(parsed.assignments),
      });
      return this.present(promotion);
    });
  }

  async update(
    storeId: string,
    id: string,
    input: PromotionInput,
    user: AuthTokenPayload,
  ) {
    await this.access.ensureStoreAccess(
      storeId,
      user,
      StorePermissionKey.manage_promotions,
    );
    const before = await this.find(storeId, id);
    if (before.status === PromotionStatus.ARCHIVED)
      throw new BadRequestException('Archived promotions cannot be edited');
    const parsed = await this.parse(
      storeId,
      { ...this.inputFrom(before), ...input },
      false,
    );
    return this.prisma.$transaction(async (tx) => {
      await tx.promotionProduct.deleteMany({ where: { promotionId: id } });
      const promotion = await tx.promotion.update({
        where: { id },
        data: {
          ...parsed.data,
          updatedByActorId: user.staffId,
          products: { create: parsed.assignments },
        },
        include: INCLUDE,
      });
      await this.audit.record(tx, {
        storeId,
        actorId: user.staffId,
        action: AuditAction.update,
        entityType: AuditEntityType.promotion,
        entityId: id,
        entityName: promotion.name,
        summary: `Promotion ${promotion.name} updated`,
        before,
        after: promotion,
        metadata: this.assignmentSummary(parsed.assignments),
      });
      return this.present(promotion);
    });
  }

  async transition(
    storeId: string,
    id: string,
    status: PromotionStatus,
    user: AuthTokenPayload,
  ) {
    await this.access.ensureStoreAccess(
      storeId,
      user,
      StorePermissionKey.activate_promotions,
    );
    const before = await this.find(storeId, id);
    if (before.status === PromotionStatus.ARCHIVED)
      throw new BadRequestException(
        'Archived promotions cannot be reactivated',
      );
    if (status === PromotionStatus.ACTIVE)
      await this.parse(storeId, this.inputFrom(before), true);
    const action =
      status === PromotionStatus.ACTIVE
        ? AuditAction.activate
        : status === PromotionStatus.PAUSED
          ? AuditAction.pause
          : status === PromotionStatus.ARCHIVED
            ? AuditAction.archive
            : AuditAction.deactivate;
    return this.prisma.$transaction(async (tx) => {
      const promotion = await tx.promotion.update({
        where: { id },
        data: {
          status,
          archivedAt: status === PromotionStatus.ARCHIVED ? new Date() : null,
          updatedByActorId: user.staffId,
        },
        include: INCLUDE,
      });
      await this.audit.record(tx, {
        storeId,
        actorId: user.staffId,
        action,
        entityType: AuditEntityType.promotion,
        entityId: id,
        entityName: promotion.name,
        summary: `Promotion ${promotion.name} ${status.toLowerCase()}`,
        before,
        after: promotion,
      });
      return this.present(promotion);
    });
  }

  async remove(storeId: string, id: string, user: AuthTokenPayload) {
    await this.access.ensureStoreAccess(
      storeId,
      user,
      StorePermissionKey.manage_promotions,
    );
    const before = await this.find(storeId, id);
    if (before.status !== PromotionStatus.DRAFT)
      return this.transition(storeId, id, PromotionStatus.ARCHIVED, user);
    return this.prisma.$transaction(async (tx) => {
      await tx.promotion.delete({ where: { id } });
      await this.audit.record(tx, {
        storeId,
        actorId: user.staffId,
        action: AuditAction.delete,
        entityType: AuditEntityType.promotion,
        entityId: id,
        entityName: before.name,
        summary: `Draft promotion ${before.name} deleted`,
        before,
      });
      return { deleted: true };
    });
  }

  async evaluate(
    storeId: string,
    input: EvaluationInput,
    user: AuthTokenPayload,
  ) {
    await this.ensureView(storeId, user);
    if (!Array.isArray(input.cartLines) || !input.cartLines.length)
      throw new BadRequestException('cartLines must be a non-empty array');
    const lines = input.cartLines.map((line, index) =>
      this.cartLine(line, index),
    );
    const at = this.date(input.at, 'at') ?? new Date();
    const records = await this.prisma.promotion.findMany({
      where: {
        storeId,
        status: { in: [PromotionStatus.ACTIVE, PromotionStatus.SCHEDULED] },
        startAt: { lte: at },
        OR: [{ endAt: null }, { endAt: { gt: at } }],
      },
      include: { products: true },
    });
    return this.evaluator.evaluate(
      lines,
      records.map((record) => ({
        id: record.id,
        name: record.name,
        type: record.type,
        priority: record.priority,
        stackable: record.stackable,
        conflictStrategy: record.conflictStrategy,
        configuration: record.configuration as PromotionConfiguration,
        maxApplicationsPerTransaction: record.maxApplicationsPerTransaction,
        excludePriceOverrides: record.excludePriceOverrides,
        qualifyingProductIds: record.products
          .filter((item) => item.role === PromotionProductRole.QUALIFYING)
          .map((item) => item.productId),
        rewardProductIds: record.products
          .filter((item) => item.role === PromotionProductRole.REWARD)
          .map((item) => item.productId),
      })),
    );
  }

  private async parse(
    storeId: string,
    input: PromotionInput,
    activation: boolean,
  ) {
    const name = this.text(input.name);
    if (!name) throw new BadRequestException('Promotion name is required');
    const type = this.enum(input.type, TYPE_VALUES, 'type');
    const status = this.enum(
      input.status ?? PromotionStatus.DRAFT,
      STATUS_VALUES,
      'status',
    );
    const startAt = this.date(input.startAt, 'startAt');
    const endAt = this.date(input.endAt, 'endAt');
    if (endAt && startAt && endAt <= startAt)
      throw new BadRequestException('endAt must be after startAt');
    const configuration = this.configuration(type, input.configuration);
    const qualifying = this.ids(
      input.qualifyingProductIds,
      'qualifyingProductIds',
    );
    const separate = input.useSeparateRewardProducts === true;
    const reward = separate
      ? this.ids(input.rewardProductIds, 'rewardProductIds')
      : [];
    if (
      (activation ||
        status === PromotionStatus.ACTIVE ||
        status === PromotionStatus.SCHEDULED) &&
      (!startAt || !qualifying.length || (separate && !reward.length))
    )
      throw new BadRequestException(
        'Activation requires a start time and all product groups',
      );
    const all = [...new Set([...qualifying, ...reward])];
    const count = await this.prisma.product.count({
      where: { storeId, id: { in: all } },
    });
    if (count !== all.length)
      throw new BadRequestException(
        'Every selected product must belong to this store',
      );
    const assignments = [
      ...qualifying.map((productId) => ({
        productId,
        role: PromotionProductRole.QUALIFYING,
      })),
      ...reward.map((productId) => ({
        productId,
        role: PromotionProductRole.REWARD,
      })),
    ];
    return {
      data: {
        name,
        description: this.text(input.description),
        type,
        status,
        startAt,
        endAt,
        priority: this.integer(input.priority, 'priority', 0, 0),
        stackable: input.stackable === true,
        conflictStrategy: this.enum(
          input.conflictStrategy ?? PromotionConflictStrategy.PRIORITY,
          STRATEGY_VALUES,
          'conflictStrategy',
        ),
        configuration: configuration as Prisma.InputJsonValue,
        internalNotes: this.text(input.internalNotes),
        useSeparateRewardProducts: separate,
        allowCashierOverride: input.allowCashierOverride === true,
        requireManagerApproval: input.requireManagerApproval === true,
        applyAutomatically: input.applyAutomatically !== false,
        printOnReceipt: input.printOnReceipt !== false,
        displayAtPos: input.displayAtPos !== false,
        stopLowerPriority: input.stopLowerPriority === true,
        excludePriceOverrides: input.excludePriceOverrides !== false,
        allowRepeatedApplications: input.allowRepeatedApplications !== false,
        maxApplicationsPerTransaction: this.optionalInteger(
          input.maxApplicationsPerTransaction,
          'maxApplicationsPerTransaction',
        ),
        maxDiscountedQuantityPerTransaction: this.optionalInteger(
          input.maxDiscountedQuantityPerTransaction,
          'maxDiscountedQuantityPerTransaction',
        ),
        limitOneUsePerCustomer: input.limitOneUsePerCustomer === true,
        loyaltyRequired: input.loyaltyRequired === true,
        allowEbtProducts: input.allowEbtProducts !== false,
        applyBeforeTax: input.applyBeforeTax !== false,
      },
      assignments,
    };
  }

  private configuration(type: PromotionType, value: unknown) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new BadRequestException('configuration must be an object');
    const c = value as Record<string, unknown>;
    const req = (key: string, percentage = false, integer = false) => {
      const n = Number(c[key]);
      if (
        !Number.isFinite(n) ||
        n < 0 ||
        (integer && (!Number.isInteger(n) || n < 1)) ||
        (percentage && (n <= 0 || n > 100))
      )
        throw new BadRequestException(`configuration.${key} is invalid`);
      return n;
    };
    const specs: Partial<
      Record<PromotionType, Array<[string, boolean?, boolean?]>>
    > = {
      BUY_X_GET_Y_FREE: [
        ['buyQuantity', false, true],
        ['rewardQuantity', false, true],
      ],
      BUY_X_GET_Y_PERCENT_OFF: [
        ['buyQuantity', false, true],
        ['discountedQuantity', false, true],
        ['discountPercentage', true],
      ],
      BUY_X_GET_Y_FIXED_PRICE: [
        ['buyQuantity', false, true],
        ['discountedQuantity', false, true],
        ['fixedRewardPrice'],
      ],
      QUANTITY_BUNDLE_PRICE: [
        ['requiredQuantity', false, true],
        ['bundlePrice'],
      ],
      QUANTITY_PERCENT_OFF: [
        ['requiredQuantity', false, true],
        ['discountPercentage', true],
      ],
      FIXED_AMOUNT_OFF_ITEM: [
        ['discountAmount'],
        ['minimumQuantity', false, true],
      ],
      PERCENT_OFF_ITEM: [
        ['discountPercentage', true],
        ['minimumQuantity', false, true],
      ],
      FIXED_AMOUNT_OFF_GROUP: [
        ['requiredQuantity', false, true],
        ['discountAmount'],
      ],
      MIX_AND_MATCH_BUNDLE: [
        ['requiredQuantity', false, true],
        ['bundlePrice'],
      ],
      SPEND_THRESHOLD_FIXED_OFF: [['minimumSpend'], ['discountAmount']],
      SPEND_THRESHOLD_PERCENT_OFF: [
        ['minimumSpend'],
        ['discountPercentage', true],
      ],
      CUSTOM_PRICE: [['promotionalUnitPrice']],
    };
    for (const [key, percentage, integer] of specs[type] ?? [])
      req(key, percentage, integer);
    return Object.fromEntries(
      Object.entries(c).filter(
        ([, entry]) =>
          typeof entry === 'boolean' ||
          (typeof entry === 'number' && Number.isFinite(entry)),
      ),
    );
  }

  private async ensureView(storeId: string, user: AuthTokenPayload) {
    try {
      await this.access.ensureStoreAccess(
        storeId,
        user,
        StorePermissionKey.view_promotions,
      );
    } catch {
      await this.access.ensureStoreAccess(
        storeId,
        user,
        StorePermissionKey.manage_products,
      );
    }
  }
  private find(storeId: string, id: string) {
    return this.prisma.promotion
      .findFirst({ where: { id, storeId }, include: INCLUDE })
      .then((item) => {
        if (!item) throw new NotFoundException('Promotion not found');
        return item;
      });
  }
  private present<
    T extends {
      status: PromotionStatus;
      startAt: Date | null;
      endAt: Date | null;
      products: Array<{ role: PromotionProductRole; product: unknown }>;
    },
  >(item: T) {
    return {
      ...item,
      effectiveStatus: this.effectiveStatus(
        item.status,
        item.startAt,
        item.endAt,
        new Date(),
      ),
      qualifyingProducts: item.products
        .filter((p) => p.role === PromotionProductRole.QUALIFYING)
        .map((p) => p.product),
      rewardProducts: item.products
        .filter((p) => p.role === PromotionProductRole.REWARD)
        .map((p) => p.product),
    };
  }
  private effectiveStatus(
    status: PromotionStatus,
    start: Date | null,
    end: Date | null,
    now: Date,
  ) {
    if (
      (
        [
          PromotionStatus.DRAFT,
          PromotionStatus.PAUSED,
          PromotionStatus.INACTIVE,
          PromotionStatus.ARCHIVED,
        ] as PromotionStatus[]
      ).includes(status)
    )
      return status;
    if (end && end <= now) return PromotionStatus.EXPIRED;
    if (start && start > now) return PromotionStatus.SCHEDULED;
    return PromotionStatus.ACTIVE;
  }
  private statusRank(status: PromotionStatus) {
    return (
      {
        ACTIVE: 0,
        SCHEDULED: 1,
        DRAFT: 2,
        PAUSED: 3,
        EXPIRED: 4,
        INACTIVE: 4,
        ARCHIVED: 5,
      } as Record<PromotionStatus, number>
    )[status];
  }
  private inputFrom(
    item: Record<string, unknown> & {
      products: Array<{ role: PromotionProductRole; productId: string }>;
    },
  ): PromotionInput {
    return {
      ...item,
      qualifyingProductIds: item.products
        .filter((p) => p.role === PromotionProductRole.QUALIFYING)
        .map((p) => p.productId),
      rewardProductIds: item.products
        .filter((p) => p.role === PromotionProductRole.REWARD)
        .map((p) => p.productId),
    };
  }
  private assignmentSummary(items: Array<{ role: PromotionProductRole }>) {
    return {
      qualifyingProducts: items.filter(
        (i) => i.role === PromotionProductRole.QUALIFYING,
      ).length,
      rewardProducts: items.filter(
        (i) => i.role === PromotionProductRole.REWARD,
      ).length,
    };
  }
  private cartLine(value: unknown, index: number) {
    if (!value || typeof value !== 'object')
      throw new BadRequestException(`cartLines[${index}] is invalid`);
    const line = value as Record<string, unknown>;
    const productId = this.text(line.productId);
    const quantity = Number(line.quantity);
    const unitPrice = Number(line.unitPrice);
    if (
      !productId ||
      !Number.isInteger(quantity) ||
      quantity < 1 ||
      !Number.isFinite(unitPrice) ||
      unitPrice < 0
    )
      throw new BadRequestException(`cartLines[${index}] is invalid`);
    return {
      productId,
      quantity,
      unitPrice,
      priceOverride: line.priceOverride === true,
    };
  }
  private ids(value: unknown, field: string) {
    if (!Array.isArray(value)) return [];
    const ids = value.map((id) => this.text(id));
    if (ids.some((id) => !id))
      throw new BadRequestException(`${field} must contain IDs`);
    return [...new Set(ids as string[])];
  }
  private text(value: unknown) {
    return typeof value === 'string' && value.trim() ? value.trim() : null;
  }
  private date(value: unknown, field: string) {
    if (value === null || value === undefined || value === '') return null;
    if (!(typeof value === 'string' || value instanceof Date))
      throw new BadRequestException(`${field} must be a valid timestamp`);
    const date = new Date(value);
    if (Number.isNaN(date.getTime()))
      throw new BadRequestException(`${field} must be a valid timestamp`);
    return date;
  }
  private enum<T>(value: unknown, values: T[], field: string): T {
    if (!values.includes(value as T))
      throw new BadRequestException(`${field} is invalid`);
    return value as T;
  }
  private positive(value: unknown, field: string, fallback: number) {
    if (value === undefined) return fallback;
    return this.integer(value, field, fallback, 1);
  }
  private integer(
    value: unknown,
    field: string,
    fallback: number,
    min: number,
  ) {
    if (value === undefined || value === null || value === '') return fallback;
    const n = Number(value);
    if (!Number.isInteger(n) || n < min)
      throw new BadRequestException(
        `${field} must be an integer of at least ${min}`,
      );
    return n;
  }
  private optionalInteger(value: unknown, field: string) {
    return value === undefined || value === null || value === ''
      ? null
      : this.integer(value, field, 1, 1);
  }
}
