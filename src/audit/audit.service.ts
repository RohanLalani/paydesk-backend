import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  AuditAction,
  AuditEntityType,
  Prisma,
  StorePermissionKey,
} from '@prisma/client';
import { AuthTokenPayload } from '../auth/strategies/jwt.strategy';
import { PosAccessService } from '../common/pos-access.service';
import { PrismaService } from '../prisma.service';

type PrismaWriter = PrismaService | Prisma.TransactionClient;

type AuditRecordInput = {
  storeId: string;
  actorId?: string | null;
  ownerId?: string | null;
  action: AuditAction;
  entityType: AuditEntityType;
  entityId?: string | null;
  entityName?: string | null;
  summary: string;
  before?: unknown;
  after?: unknown;
  metadata?: unknown;
  requestId?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
};

type AuditQuery = {
  page?: unknown;
  limit?: unknown;
  action?: unknown;
  entityType?: unknown;
  actorId?: unknown;
  search?: unknown;
};

type ProductLogQuery = {
  page?: unknown;
  limit?: unknown;
  search?: unknown;
  timeRange?: unknown;
  from?: unknown;
  to?: unknown;
  changeType?: unknown;
  field?: unknown;
  actorId?: unknown;
  changedBy?: unknown;
  source?: unknown;
  departmentId?: unknown;
  categoryId?: unknown;
  priceGroupId?: unknown;
  sort?: unknown;
  order?: unknown;
};

type ProductLogRow = {
  id: string;
  auditEventId: string;
  storeId: string;
  productId: string | null;
  timestamp: Date;
  productNumber: number | null;
  barcode: string | null;
  productDescription: string | null;
  departmentId: string | null;
  categoryId: string | null;
  priceGroupId: string | null;
  changeType: string;
  changesSummary: string;
  changedFields: Array<{
    field: string;
    fieldLabel: string;
    previousValue: unknown;
    newValue: unknown;
  }>;
  changedBy: {
    id: string;
    name: string | null;
    email: string;
    role: string;
  } | null;
  source: string;
  reference: string | null;
  referenceType: string | null;
  referenceId: string | null;
  details: {
    summary: string;
    action: AuditAction;
    entityType: AuditEntityType;
    metadata: unknown;
  };
};

const SENSITIVE_KEY_PATTERN =
  /password|token|secret|authorization|cookie|hash|code|reset|verification|fingerprint/i;
const MAX_STRING_LENGTH = 1_000;
const MAX_ARRAY_LENGTH = 50;
const PRODUCT_AUDIT_FIELD_LABELS: Record<string, string> = {
  productNumber: 'Product Number',
  barcode: 'Barcode',
  name: 'Product Description',
  saleType: 'Sale Type',
  unitsPerCase: 'Units Per Case',
  caseCost: 'Case Cost',
  caseDiscount: 'Case Discount',
  caseRebate: 'Case Rebate',
  unitCost: 'Unit Cost',
  unitCostAfterDiscountAndRebate: 'Unit Cost After Discount / Rebate',
  unitRetail: 'Unit Retail',
  onlineRetailPrice: 'Online Retail',
  unitOfMeasure: 'Unit of Measure',
  size: 'Size',
  margin: 'Margin',
  defaultMargin: 'Default Margin',
  maxInventory: 'Maximum Inventory',
  minInventory: 'Minimum Inventory',
  minimumAge: 'Minimum Age',
  nacsCode: 'NACS Code',
  nacsCategory: 'NACS Category',
  nacsSubCategory: 'NACS Subcategory',
  blueLaw: 'Blue Law',
  kitchenPrint: 'Kitchen Print',
  allowEbt: 'EBT Eligible',
  trackInventory: 'Track Inventory',
  allowNegativeInventory: 'Negative Inventory Sales',
  taxStyle: 'Tax Style',
  isActive: 'Status',
  departmentId: 'Department',
  priceGroupId: 'Price Group',
  productCategoryId: 'Category',
  taxId: 'Tax',
  linkedItems: 'Linked Items',
};

const PRODUCT_AUDIT_EXCLUDED_FIELDS = new Set([
  'currentQuantity',
  'createdAt',
  'updatedAt',
  'store',
  'storeId',
  'department',
  'priceGroup',
  'productCategory',
  'tax',
]);

const PRODUCT_AUDIT_ALLOWED_LIMITS = new Set([25, 50, 100, 250]);

@Injectable()
export class AuditService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: PosAccessService,
  ) {}

  async record(tx: PrismaWriter, input: AuditRecordInput) {
    const before = this.sanitize(input.before);
    const after = this.sanitize(input.after);

    return tx.auditEvent.create({
      data: {
        storeId: input.storeId,
        actorId: input.actorId ?? null,
        ownerId: input.ownerId ?? null,
        action: input.action,
        entityType: input.entityType,
        entityId: input.entityId ?? null,
        entityName: input.entityName ?? null,
        summary: input.summary,
        before: before as Prisma.InputJsonValue,
        after: after as Prisma.InputJsonValue,
        changes: this.diff(before, after) as Prisma.InputJsonValue,
        metadata: this.sanitize(input.metadata) as Prisma.InputJsonValue,
        requestId: input.requestId ?? null,
        ipAddress: input.ipAddress ?? null,
        userAgent: input.userAgent ?? null,
      },
    });
  }

  async list(storeId: string, user: AuthTokenPayload, query: AuditQuery = {}) {
    await this.access.ensureStoreAccess(
      storeId,
      user,
      StorePermissionKey.view_audit_logs,
    );

    const pagination = this.parsePagination(query);
    const where = this.buildWhere(storeId, query);
    const [items, total] = await Promise.all([
      this.prisma.auditEvent.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: pagination.skip,
        take: pagination.limit,
        select: {
          id: true,
          storeId: true,
          actorId: true,
          action: true,
          entityType: true,
          entityId: true,
          entityName: true,
          summary: true,
          createdAt: true,
          actor: {
            select: {
              id: true,
              name: true,
              email: true,
              role: true,
            },
          },
        },
      }),
      this.prisma.auditEvent.count({ where }),
    ]);

    return {
      items,
      total,
      page: pagination.page,
      limit: pagination.limit,
    };
  }

  async get(storeId: string, eventId: string, user: AuthTokenPayload) {
    await this.access.ensureStoreAccess(
      storeId,
      user,
      StorePermissionKey.view_audit_logs,
    );

    const event = await this.prisma.auditEvent.findFirst({
      where: { id: eventId, storeId },
      include: {
        actor: {
          select: {
            id: true,
            name: true,
            email: true,
            role: true,
          },
        },
      },
    });

    if (!event) {
      throw new NotFoundException('Audit event not found');
    }

    return event;
  }

  async listProductLogs(
    storeId: string,
    user: AuthTokenPayload,
    query: ProductLogQuery = {},
  ) {
    await this.access.ensureStoreAccess(
      storeId,
      user,
      StorePermissionKey.view_audit_logs,
    );

    const pagination = this.parseProductLogPagination(query);
    const dateRange = this.parseProductLogDateRange(query);
    const source = this.optionalString(query.source, 'source');
    const actorId = this.optionalString(query.actorId, 'actorId');
    const changedBy = this.optionalString(query.changedBy, 'changedBy');
    const search = this.optionalString(query.search, 'search');
    const changeType = this.optionalString(query.changeType, 'changeType');
    const field = this.optionalString(query.field, 'field');
    const departmentId = this.optionalString(query.departmentId, 'departmentId');
    const categoryId = this.optionalString(query.categoryId, 'categoryId');
    const priceGroupId = this.optionalString(
      query.priceGroupId,
      'priceGroupId',
    );
    const sort = this.optionalSort(
      query.sort,
      [
        'timestamp',
        'productNumber',
        'productDescription',
        'changeType',
        'changedBy',
      ],
      'timestamp',
      'sort',
    );
    const order = this.optionalSort(query.order, ['asc', 'desc'], 'desc', 'order');

    const where: Prisma.AuditEventWhereInput = {
      storeId,
      entityType: AuditEntityType.product,
      ...(actorId ? { actorId } : {}),
      ...(dateRange
        ? {
            createdAt: {
              ...(dateRange.from ? { gte: dateRange.from } : {}),
              ...(dateRange.to ? { lte: dateRange.to } : {}),
            },
          }
        : {}),
    };

    const events = await this.prisma.auditEvent.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      include: {
        actor: {
          select: {
            id: true,
            name: true,
            email: true,
            role: true,
          },
        },
      },
    });

    const rows = events
      .map((event) => this.productAuditEventToRow(event))
      .filter((row): row is ProductLogRow => row !== null)
      .filter((row) =>
        this.matchesProductLogFilters(row, {
          search,
          source,
          changeType,
          field,
          changedBy,
          departmentId,
          categoryId,
          priceGroupId,
        }),
      )
      .sort((left, right) =>
        this.compareProductLogRows(left, right, sort, order),
      );

    const items = rows.slice(pagination.skip, pagination.skip + pagination.limit);

    return {
      items,
      total: rows.length,
      page: pagination.page,
      limit: pagination.limit,
      totalPages: Math.max(1, Math.ceil(rows.length / pagination.limit)),
    };
  }

  private buildWhere(storeId: string, query: AuditQuery) {
    const where: Prisma.AuditEventWhereInput = { storeId };
    const action = this.optionalEnum(query.action, AuditAction, 'action');
    const entityType = this.optionalEnum(
      query.entityType,
      AuditEntityType,
      'entityType',
    );
    const actorId = this.optionalString(query.actorId, 'actorId');
    const search = this.optionalString(query.search, 'search');

    if (action) where.action = action;
    if (entityType) where.entityType = entityType;
    if (actorId) where.actorId = actorId;
    if (search) {
      where.OR = [
        { summary: { contains: search, mode: 'insensitive' } },
        { entityName: { contains: search, mode: 'insensitive' } },
      ];
    }

    return where;
  }

  private parsePagination(query: AuditQuery) {
    const page = this.optionalPositiveInteger(query.page, 'page') ?? 1;
    const limit = Math.min(
      this.optionalPositiveInteger(query.limit, 'limit') ?? 25,
      100,
    );

    return { page, limit, skip: (page - 1) * limit };
  }

  private parseProductLogPagination(query: ProductLogQuery) {
    const page = this.optionalPositiveInteger(query.page, 'page') ?? 1;
    const requestedLimit =
      this.optionalPositiveInteger(query.limit, 'limit') ?? 25;
    const limit = PRODUCT_AUDIT_ALLOWED_LIMITS.has(requestedLimit)
      ? requestedLimit
      : 25;

    return { page, limit, skip: (page - 1) * limit };
  }

  private parseProductLogDateRange(query: ProductLogQuery) {
    const explicitFrom = this.optionalDate(query.from, 'from');
    const explicitTo = this.optionalDate(query.to, 'to');

    if (explicitFrom || explicitTo) {
      return { from: explicitFrom, to: explicitTo };
    }

    const timeRange = this.optionalString(query.timeRange, 'timeRange');
    if (!timeRange || timeRange === 'all') return null;

    const now = new Date();
    const startOfToday = new Date(now);
    startOfToday.setHours(0, 0, 0, 0);

    if (timeRange === 'today') {
      return { from: startOfToday, to: undefined };
    }
    if (timeRange === 'yesterday') {
      const from = new Date(startOfToday);
      from.setDate(from.getDate() - 1);
      return { from, to: startOfToday };
    }
    if (timeRange === '7d' || timeRange === '30d') {
      const from = new Date(now);
      from.setDate(from.getDate() - (timeRange === '7d' ? 7 : 30));
      return { from, to: undefined };
    }

    throw new BadRequestException('timeRange must be valid');
  }

  private optionalDate(value: unknown, field: string) {
    const text = this.optionalString(value, field);
    if (!text) return undefined;

    const date = new Date(text);
    if (Number.isNaN(date.getTime())) {
      throw new BadRequestException(`${field} must be a valid date`);
    }

    return date;
  }

  private optionalSort<T extends string>(
    value: unknown,
    allowed: readonly T[],
    fallback: T,
    field: string,
  ) {
    if (value === undefined || value === null || value === '') return fallback;
    if (typeof value !== 'string' || !allowed.includes(value as T)) {
      throw new BadRequestException(`${field} must be valid`);
    }

    return value as T;
  }

  private productAuditEventToRow(
    event: Prisma.AuditEventGetPayload<{
      include: {
        actor: {
          select: { id: true; name: true; email: true; role: true };
        };
      };
    }>,
  ): ProductLogRow | null {
    const before = this.asRecord(event.before);
    const after = this.asRecord(event.after);
    const metadata = this.asRecord(event.metadata);
    const product = after ?? before ?? {};
    const source = this.resolveProductLogSource(metadata);
    const reference = this.resolveProductLogReference(metadata);
    const base = {
      id: event.id,
      auditEventId: event.id,
      storeId: event.storeId,
      productId: this.stringValue(product.id) ?? event.entityId ?? null,
      timestamp: event.createdAt,
      productNumber: this.numberValue(product.productNumber),
      barcode: this.stringValue(product.barcode),
      productDescription:
        this.stringValue(product.name) ?? event.entityName ?? null,
      departmentId: this.stringValue(product.departmentId),
      categoryId: this.stringValue(product.productCategoryId),
      priceGroupId: this.stringValue(product.priceGroupId),
      changedBy: event.actor,
      source,
      reference: reference.label,
      referenceType: reference.type,
      referenceId: reference.id,
      details: {
        summary: event.summary,
        action: event.action,
        entityType: event.entityType,
        metadata: event.metadata,
      },
    };

    if (event.action === AuditAction.create) {
      return {
        ...base,
        changeType: 'Created',
        changesSummary: 'Product created',
        changedFields: [
          {
            field: 'created',
            fieldLabel: 'Product Record',
            previousValue: null,
            newValue: 'Created',
          },
        ],
      };
    }

    const changes = this.asRecord(event.changes);
    if (!changes) return null;

    const changedFields = Object.entries(changes)
      .filter(([key]) => this.isProductAuditField(key))
      .map(([key, value]) => {
        const change = this.asRecord(value);
        const previousValue = this.resolveProductAuditValue(
          key,
          change?.before,
          before,
        );
        const newValue = this.resolveProductAuditValue(key, change?.after, after);

        return {
          field: key,
          fieldLabel: PRODUCT_AUDIT_FIELD_LABELS[key] ?? this.humanize(key),
          previousValue,
          newValue,
        };
      });

    if (!changedFields.length) return null;

    return {
      ...base,
      changeType: this.resolveGroupedProductLogChangeType(
        changedFields.map((change) => change.field),
        changedFields,
        event.action,
      ),
      changesSummary: this.resolveChangesSummary(changedFields),
      changedFields,
    };
  }

  private matchesProductLogFilters(
    row: ProductLogRow,
    filters: {
      search?: string;
      source?: string;
      changeType?: string;
      field?: string;
      changedBy?: string;
      departmentId?: string;
      categoryId?: string;
      priceGroupId?: string;
    },
  ) {
    if (filters.source && row.source !== filters.source) return false;
    if (filters.changeType && row.changeType !== filters.changeType) return false;
    if (
      filters.field &&
      !row.changedFields.some((change) => change.field === filters.field)
    ) {
      return false;
    }
    if (filters.changedBy) {
      const actorNeedle = filters.changedBy.toLowerCase();
      const actorText = `${row.changedBy?.name ?? ''} ${row.changedBy?.email ?? ''}`.toLowerCase();
      if (!actorText.includes(actorNeedle)) return false;
    }
    if (filters.departmentId && row.departmentId !== filters.departmentId) {
      return false;
    }
    if (filters.categoryId && row.categoryId !== filters.categoryId) {
      return false;
    }
    if (filters.priceGroupId && row.priceGroupId !== filters.priceGroupId) {
      return false;
    }

    if (!filters.search) return true;
    const needle = filters.search.toLowerCase();

    return [
      row.productNumber,
      row.barcode,
      row.productDescription,
      row.changesSummary,
      ...row.changedFields.map((change) => change.fieldLabel),
      row.changeType,
      row.changedBy?.name,
      row.changedBy?.email,
      row.source,
      row.reference,
    ]
      .filter((value) => value !== null && value !== undefined)
      .some((value) => String(value).toLowerCase().includes(needle));
  }

  private compareProductLogRows(
    left: ProductLogRow,
    right: ProductLogRow,
    sort: string,
    order: string,
  ) {
    const direction = order === 'asc' ? 1 : -1;
    const value = (row: ProductLogRow) => {
      if (sort === 'timestamp') return row.timestamp.getTime();
      if (sort === 'productNumber') return row.productNumber ?? 0;
      if (sort === 'productDescription') return row.productDescription ?? '';
      if (sort === 'changeType') return row.changeType;
      if (sort === 'changedBy')
        return row.changedBy?.name ?? row.changedBy?.email ?? 'System';
      return row.timestamp.getTime();
    };
    const leftValue = value(left);
    const rightValue = value(right);

    if (typeof leftValue === 'number' && typeof rightValue === 'number') {
      return (leftValue - rightValue) * direction;
    }

    return String(leftValue).localeCompare(String(rightValue)) * direction;
  }

  private isProductAuditField(key: string) {
    return (
      !PRODUCT_AUDIT_EXCLUDED_FIELDS.has(key) &&
      (PRODUCT_AUDIT_FIELD_LABELS[key] !== undefined ||
        !key.toLowerCase().includes('quantity'))
    );
  }

  private resolveProductAuditValue(
    key: string,
    value: unknown,
    snapshot: Record<string, unknown> | null,
  ) {
    if (key === 'departmentId') {
      return this.asRecord(snapshot?.department)?.name ?? value ?? null;
    }
    if (key === 'priceGroupId') {
      return this.asRecord(snapshot?.priceGroup)?.name ?? value ?? null;
    }
    if (key === 'productCategoryId') {
      return this.asRecord(snapshot?.productCategory)?.name ?? value ?? null;
    }
    if (key === 'taxId') {
      return this.asRecord(snapshot?.tax)?.name ?? value ?? null;
    }

    return value ?? null;
  }

  private resolveProductLogChangeType(
    key: string,
    previousValue: unknown,
    newValue: unknown,
    action: AuditAction,
  ) {
    if (key === 'isActive') {
      if (newValue === true) return 'Activated';
      if (newValue === false) return 'Deactivated';
    }
    if (key === 'unitRetail' || key === 'onlineRetailPrice') {
      return 'Price Change';
    }
    if (
      key === 'caseCost' ||
      key === 'unitCost' ||
      key === 'unitCostAfterDiscountAndRebate'
    ) {
      return 'Cost Change';
    }
    if (
      key === 'departmentId' ||
      key === 'productCategoryId' ||
      key === 'priceGroupId' ||
      key === 'taxId'
    ) {
      return 'Classification Change';
    }
    if (String(key).toLowerCase().includes('pack')) {
      return 'Multipack Change';
    }
    if (action === AuditAction.deactivate) return 'Deactivated';
    if (action === AuditAction.activate) return 'Activated';
    if (previousValue === null && newValue !== null) return 'Updated';

    return 'Updated';
  }

  private resolveGroupedProductLogChangeType(
    fields: string[],
    changedFields: Array<{
      field: string;
      previousValue: unknown;
      newValue: unknown;
    }>,
    action: AuditAction,
  ) {
    if (action === AuditAction.create) return 'Created';
    if (action === AuditAction.delete) return 'Deleted';

    const fieldSet = new Set(fields);
    if (fieldSet.has('isActive')) {
      const statusChange = changedFields.find(
        (change) => change.field === 'isActive',
      );
      if (statusChange?.newValue === true) return 'Activated';
      if (statusChange?.newValue === false) return 'Deactivated';
    }

    const categories = new Set(
      fields.map((field) => this.productLogChangeCategory(field)),
    );
    if (categories.size > 1) return 'Multiple Changes';
    if (categories.has('multipack')) return 'Multipack Change';
    if (categories.has('price_cost')) return 'Price and Cost Change';
    if (categories.has('classification')) return 'Classification Change';

    return 'Updated';
  }

  private productLogChangeCategory(field: string) {
    if (String(field).toLowerCase().includes('pack')) return 'multipack';
    if (
      field === 'unitRetail' ||
      field === 'onlineRetailPrice' ||
      field === 'caseCost' ||
      field === 'unitCost' ||
      field === 'unitCostAfterDiscountAndRebate'
    ) {
      return 'price_cost';
    }
    if (
      field === 'departmentId' ||
      field === 'productCategoryId' ||
      field === 'priceGroupId' ||
      field === 'taxId'
    ) {
      return 'classification';
    }

    return 'general';
  }

  private resolveChangesSummary(
    changedFields: Array<{ fieldLabel: string }>,
  ) {
    if (changedFields.length <= 3) {
      return changedFields.map((change) => change.fieldLabel).join(', ');
    }

    return `${changedFields.length} fields changed`;
  }

  private resolveProductLogSource(metadata: Record<string, unknown> | null) {
    const source = this.stringValue(metadata?.source);
    if (source === 'purchase') return 'Purchase';
    if (source === 'price_book') return 'Price Book';
    if (source === 'multi_pack_pricing') return 'Multipack Review';
    if (source === 'import') return 'Import';
    if (source === 'api') return 'API';
    if (source === 'system') return 'System';

    return 'Product Editor';
  }

  private resolveProductLogReference(metadata: Record<string, unknown> | null) {
    const type =
      this.stringValue(metadata?.referenceType) ??
      this.stringValue(metadata?.reference_type);
    const id =
      this.stringValue(metadata?.referenceId) ??
      this.stringValue(metadata?.reference_id);
    const label =
      this.stringValue(metadata?.reference) ??
      this.stringValue(metadata?.invoiceNumber) ??
      (type && id ? `${this.humanize(type)} ${id}` : null);

    return { type: type ?? null, id: id ?? null, label };
  }

  private asRecord(value: unknown): Record<string, unknown> | null {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  }

  private stringValue(value: unknown) {
    return typeof value === 'string' && value.trim() ? value.trim() : null;
  }

  private numberValue(value: unknown) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim()) {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : null;
    }

    return null;
  }

  private humanize(value: string) {
    return value
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .replace(/[_-]+/g, ' ')
      .replace(/\b\w/g, (letter) => letter.toUpperCase());
  }

  private optionalPositiveInteger(value: unknown, field: string) {
    if (value === undefined || value === null || value === '') return undefined;
    const parsed = Number(value);

    if (!Number.isInteger(parsed) || parsed < 1) {
      throw new BadRequestException(`${field} must be a positive integer`);
    }

    return parsed;
  }

  private optionalString(value: unknown, field: string) {
    if (value === undefined || value === null || value === '') return undefined;

    if (typeof value !== 'string') {
      throw new BadRequestException(`${field} must be a string`);
    }

    return value.trim() || undefined;
  }

  private optionalEnum<T extends Record<string, string>>(
    value: unknown,
    enumLike: T,
    field: string,
  ) {
    if (value === undefined || value === null || value === '') return undefined;

    if (typeof value !== 'string' || !Object.values(enumLike).includes(value)) {
      throw new BadRequestException(`${field} must be valid`);
    }

    return value as T[keyof T];
  }

  private sanitize(value: unknown, key = ''): unknown {
    if (value === undefined) return null;
    if (value === null) return null;
    if (SENSITIVE_KEY_PATTERN.test(key)) return '[redacted]';
    if (value instanceof Date) return value.toISOString();
    if (typeof value === 'bigint') return value.toString();
    if (value instanceof Prisma.Decimal) return value.toString();
    if (typeof value === 'string') {
      return value.length > MAX_STRING_LENGTH
        ? `${value.slice(0, MAX_STRING_LENGTH)}...`
        : value;
    }
    if (typeof value !== 'object') return value;
    if (Array.isArray(value)) {
      return value
        .slice(0, MAX_ARRAY_LENGTH)
        .map((item) => this.sanitize(item, key));
    }

    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(
        ([entryKey, entry]) => [entryKey, this.sanitize(entry, entryKey)],
      ),
    );
  }

  private diff(before: unknown, after: unknown) {
    if (!this.isPlainObject(before) || !this.isPlainObject(after)) return null;

    const changes: Record<string, { before: unknown; after: unknown }> = {};
    const keys = new Set([...Object.keys(before), ...Object.keys(after)]);

    for (const key of keys) {
      if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) {
        changes[key] = { before: before[key], after: after[key] };
      }
    }

    return Object.keys(changes).length ? changes : null;
  }

  private isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }
}
