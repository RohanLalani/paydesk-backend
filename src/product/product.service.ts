import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
  ForbiddenException,
} from '@nestjs/common';
import {
  AuditAction,
  AuditEntityType,
  DepartmentMinimumAge,
  DepartmentType,
  InventoryActionType,
  PaymentStatus,
  Prisma,
  ProductSaleType,
  StorePermissionKey,
  TaxStyle,
  TransactionStatus,
} from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { AuthTokenPayload } from '../auth/strategies/jwt.strategy';
import { PosAccessService } from '../common/pos-access.service';
import { PrismaService } from '../prisma.service';

type AuditRecorder = {
  record: (...args: Parameters<AuditService['record']>) => Promise<unknown>;
};

const NOOP_AUDIT: AuditRecorder = { record: () => Promise.resolve(null) };
const PRICE_BOOK_SORT_FIELDS = [
  'productNumber',
  'barcode',
  'name',
  'department',
  'category',
  'priceGroup',
  'unitRetail',
  'unitCost',
  'margin',
  'currentQuantity',
  'updatedAt',
] as const;

type PriceBookSortField = (typeof PRICE_BOOK_SORT_FIELDS)[number];
type MarginStatus = 'positive' | 'zero' | 'negative' | 'unavailable';
type InventoryOverviewRange = '7d' | '30d' | '90d';

const INVENTORY_OVERVIEW_RANGES = ['7d', '30d', '90d'] as const;
const DEFAULT_INVENTORY_OVERVIEW_RANGE: InventoryOverviewRange = '30d';
const INVENTORY_OVERVIEW_LIMIT = 10;
const DEAD_STOCK_LOOKBACK_DAYS = 90;
const DEAD_STOCK_AGE_GRACE_DAYS = 30;

@Injectable()
export class ProductService {
  private readonly logger = new Logger(ProductService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly access: PosAccessService,
    @Optional()
    private readonly audit: AuditService = NOOP_AUDIT as unknown as AuditService,
  ) {}

  async createDepartment(
    body: Record<string, unknown>,
    user: AuthTokenPayload,
  ) {
    const { storeId, ...departmentBody } = body;
    return this.createStoreDepartment(
      this.requiredString(storeId, 'storeId'),
      departmentBody,
      user,
    );
  }

  async listDepartments(storeId: string, user: AuthTokenPayload) {
    await this.access.ensureStoreAccess(storeId, user, 'manage_products');

    return this.prisma.department.findMany({
      where: { storeId, isActive: true },
      orderBy: { name: 'asc' },
    });
  }

  async listStoreDepartments(
    storeId: string,
    user: AuthTokenPayload,
    query: Record<string, unknown> = {},
  ) {
    await this.access.ensureStoreAccess(storeId, user, 'manage_products');
    const active = this.optionalQueryBoolean(query.active, 'active');
    const search = this.optionalSearch(query.search, 'search');
    const sort = this.optionalSort(
      query.sort,
      ['posDepartmentNumber', 'name', 'createdAt', 'updatedAt'],
      'posDepartmentNumber',
      'sort',
    );
    const order = this.optionalSort(
      query.order,
      ['asc', 'desc'],
      'asc',
      'order',
    );
    const pagination = this.parsePageLimit(query);
    const onPos = this.optionalQueryBoolean(query.onPos, 'onPos');
    const where: Prisma.DepartmentWhereInput = {
      storeId,
      ...(active === undefined ? {} : { isActive: active }),
      ...(onPos === undefined ? {} : { onPos }),
      ...(search
        ? {
            OR: [
              { name: { contains: search, mode: 'insensitive' } },
              ...(this.isPositiveIntegerText(search)
                ? [{ posDepartmentNumber: Number(search) }]
                : []),
            ],
          }
        : {}),
    };
    const orderBy =
      sort === 'posDepartmentNumber'
        ? [{ posDepartmentNumber: order }, { name: 'asc' as const }]
        : [{ [sort]: order }, { posDepartmentNumber: 'asc' as const }];

    const [departments, total] = await Promise.all([
      this.prisma.department.findMany({
        where,
        orderBy,
        skip: pagination.skip,
        take: pagination.limit,
        include: {
          _count: {
            select: { products: true },
          },
          defaultTax: true,
        },
      }),
      this.prisma.department.count({ where }),
    ]);

    return {
      items: departments.map((department) =>
        this.serializeDepartment(department),
      ),
      total,
      page: pagination.page,
      limit: pagination.limit,
    };
  }

  async createStoreDepartment(
    storeId: string,
    body: Record<string, unknown>,
    user: AuthTokenPayload,
  ) {
    await this.access.ensureStoreAccess(storeId, user, 'manage_products');
    const dto = this.parseCreateDepartmentBody(body);
    await this.ensureDepartmentNameAvailable(storeId, dto.name);
    await this.ensureDepartmentNumberAvailable(
      storeId,
      dto.posDepartmentNumber,
    );
    await this.ensureActiveTaxInStore(storeId, dto.defaultTaxId);

    try {
      const department = await this.runInTransaction(async (tx) => {
        const created = await tx.department.create({
          data: {
            storeId,
            ...dto,
            defaultAllowEbt: dto.allowEbt,
          },
          include: {
            _count: { select: { products: true } },
            defaultTax: true,
          },
        });

        await this.audit.record(tx, {
          storeId,
          actorId: user.staffId,
          ownerId: user.type === 'owner' ? user.accountId : null,
          action: AuditAction.create,
          entityType: AuditEntityType.department,
          entityId: created.id,
          entityName: created.name,
          summary: `Created department ${created.name}`,
          after: created,
        });

        return created;
      });
      return this.serializeDepartment(department);
    } catch (error) {
      this.handleDepartmentConflict(error);
      throw error;
    }
  }

  async updateStoreDepartment(
    storeId: string,
    departmentId: string,
    body: Record<string, unknown>,
    user: AuthTokenPayload,
  ) {
    await this.access.ensureStoreAccess(storeId, user, 'manage_products');
    const department = await this.findDepartmentInStoreOrThrow(
      departmentId,
      storeId,
    );
    const data = this.parseUpdateDepartmentBody(body);

    if (data.name !== undefined) {
      await this.ensureDepartmentNameAvailable(
        storeId,
        data.name,
        department.id,
      );
    }
    if (data.posDepartmentNumber !== undefined) {
      await this.ensureDepartmentNumberAvailable(
        storeId,
        data.posDepartmentNumber,
        department.id,
      );
    }
    if (data.defaultTaxId !== undefined) {
      await this.ensureActiveTaxInStore(storeId, data.defaultTaxId);
    }

    try {
      const updated = await this.runInTransaction(async (tx) => {
        const updatedDepartment = await tx.department.update({
          where: { id: department.id },
          data: {
            ...data,
            ...(data.allowEbt === undefined
              ? {}
              : { defaultAllowEbt: data.allowEbt }),
          },
          include: {
            _count: { select: { products: true } },
            defaultTax: true,
          },
        });

        await this.audit.record(tx, {
          storeId,
          actorId: user.staffId,
          ownerId: user.type === 'owner' ? user.accountId : null,
          action: updatedDepartment.isActive
            ? AuditAction.update
            : AuditAction.deactivate,
          entityType: AuditEntityType.department,
          entityId: updatedDepartment.id,
          entityName: updatedDepartment.name,
          summary: `Updated department ${updatedDepartment.name}`,
          before: department,
          after: updatedDepartment,
        });

        return updatedDepartment;
      });
      return this.serializeDepartment(updated);
    } catch (error) {
      this.handleDepartmentConflict(error);
      throw error;
    }
  }

  async updateDepartment(
    id: string,
    body: Record<string, unknown>,
    user: AuthTokenPayload,
  ) {
    const department = await this.findDepartmentOrThrow(id);
    await this.access.ensureStoreAccess(
      department.storeId,
      user,
      'manage_products',
    );
    const data: Prisma.DepartmentUpdateInput = {};

    if (body.name !== undefined) {
      data.name = this.requiredString(body.name, 'name');
    }

    if (body.defaultAllowEbt !== undefined) {
      data.defaultAllowEbt = this.requiredBoolean(
        body.defaultAllowEbt,
        'defaultAllowEbt',
      );
    }

    try {
      return await this.prisma.department.update({ where: { id }, data });
    } catch (error) {
      this.handleSetupNameConflict(error, 'department');
      throw error;
    }
  }

  async deleteDepartment(id: string, user: AuthTokenPayload) {
    const department = await this.findDepartmentOrThrow(id);
    await this.access.ensureStoreAccess(
      department.storeId,
      user,
      'manage_products',
    );
    await this.ensureSetupTableNotInUse(
      { departmentId: id },
      'Department is used by products and cannot be deleted',
    );

    return this.runInTransaction(async (tx) => {
      const updated = await tx.department.update({
        where: { id },
        data: { isActive: false },
      });

      await this.audit.record(tx, {
        storeId: department.storeId,
        actorId: user.staffId,
        ownerId: user.type === 'owner' ? user.accountId : null,
        action: AuditAction.deactivate,
        entityType: AuditEntityType.department,
        entityId: updated.id,
        entityName: updated.name,
        summary: `Deactivated department ${updated.name}`,
        before: department,
        after: updated,
      });

      return updated;
    });
  }

  async createPriceGroup(
    body: Record<string, unknown>,
    user: AuthTokenPayload,
  ) {
    const storeId = this.requiredString(body.storeId, 'storeId');
    return this.createStorePriceGroup(storeId, body, user);
  }

  async listPriceGroups(storeId: string, user: AuthTokenPayload) {
    await this.access.ensureStoreAccess(storeId, user, 'manage_products');

    const priceGroups = await this.prisma.priceGroup.findMany({
      where: { storeId, isActive: true },
      orderBy: { name: 'asc' },
      include: { _count: { select: { products: true } } },
    });

    return priceGroups.map((priceGroup) =>
      this.serializePriceGroup(priceGroup),
    );
  }

  async listStorePriceGroups(
    storeId: string,
    user: AuthTokenPayload,
    query: Record<string, unknown> = {},
  ) {
    await this.access.ensureStoreAccess(storeId, user, 'manage_products');
    const active = this.optionalQueryBoolean(query.active, 'active');
    const search = this.optionalSearch(query.search, 'search');

    const priceGroups = await this.prisma.priceGroup.findMany({
      where: {
        storeId,
        ...(active === undefined ? {} : { isActive: active }),
        ...(search ? { name: { contains: search, mode: 'insensitive' } } : {}),
      },
      orderBy: [{ isActive: 'desc' }, { name: 'asc' }],
      include: { _count: { select: { products: true } } },
    });

    return {
      items: priceGroups.map((priceGroup) =>
        this.serializePriceGroup(priceGroup),
      ),
      total: priceGroups.length,
    };
  }

  async createStorePriceGroup(
    storeId: string,
    body: Record<string, unknown>,
    user: AuthTokenPayload,
  ) {
    await this.access.ensureStoreAccess(storeId, user, 'manage_products');
    const dto = this.parseCreatePriceGroupBody(body);
    await this.ensurePriceGroupNameAvailable(storeId, dto.name);

    try {
      const priceGroup = await this.runInTransaction(async (tx) => {
        const created = await tx.priceGroup.create({
          data: {
            ...dto,
            storeId,
            mismatchCountUpdatedAt: new Date(),
          },
          include: { _count: { select: { products: true } } },
        });

        await this.audit.record(tx, {
          storeId,
          actorId: user.staffId,
          ownerId: user.type === 'owner' ? user.accountId : null,
          action: AuditAction.create,
          entityType: AuditEntityType.price_group,
          entityId: created.id,
          entityName: created.name,
          summary: `Created price group ${created.name}`,
          after: created,
        });

        return created;
      });

      return this.serializePriceGroup(priceGroup);
    } catch (error) {
      this.handleSetupNameConflict(error, 'price group');
      throw error;
    }
  }

  async getStorePriceGroup(
    storeId: string,
    priceGroupId: string,
    user: AuthTokenPayload,
  ) {
    await this.access.ensureStoreAccess(storeId, user, 'manage_products');
    const priceGroup = await this.prisma.priceGroup.findFirst({
      where: { id: priceGroupId, storeId },
      include: { _count: { select: { products: true } } },
    });

    if (!priceGroup) {
      throw new NotFoundException('Price group not found');
    }

    return this.serializePriceGroup(priceGroup);
  }

  async updateStorePriceGroup(
    storeId: string,
    priceGroupId: string,
    body: Record<string, unknown>,
    user: AuthTokenPayload,
  ) {
    await this.access.ensureStoreAccess(storeId, user, 'manage_products');
    const priceGroup = await this.findPriceGroupInStoreOrThrow(
      priceGroupId,
      storeId,
    );
    const data = this.parseUpdatePriceGroupBody(body);

    if (data.name !== undefined) {
      await this.ensurePriceGroupNameAvailable(
        storeId,
        data.name,
        priceGroupId,
      );
    }

    const defaultPriceChanged =
      data.defaultUnitRetail !== undefined &&
      !new Prisma.Decimal(data.defaultUnitRetail).equals(
        priceGroup.defaultUnitRetail,
      );

    try {
      const updated = await this.runInTransaction(async (tx) => {
        const updatedPriceGroup = await tx.priceGroup.update({
          where: { id: priceGroupId },
          data,
          include: { _count: { select: { products: true } } },
        });

        await this.audit.record(tx, {
          storeId,
          actorId: user.staffId,
          ownerId: user.type === 'owner' ? user.accountId : null,
          action: updatedPriceGroup.isActive
            ? AuditAction.update
            : AuditAction.deactivate,
          entityType: AuditEntityType.price_group,
          entityId: updatedPriceGroup.id,
          entityName: updatedPriceGroup.name,
          summary: `Updated price group ${updatedPriceGroup.name}`,
          before: priceGroup,
          after: updatedPriceGroup,
        });

        return updatedPriceGroup;
      });

      if (defaultPriceChanged) {
        await this.safeRecountPriceGroups([priceGroupId]);
        return this.getStorePriceGroup(storeId, priceGroupId, user);
      }

      return this.serializePriceGroup(updated);
    } catch (error) {
      this.handleSetupNameConflict(error, 'price group');
      throw error;
    }
  }

  async listStorePriceGroupProducts(
    storeId: string,
    priceGroupId: string,
    user: AuthTokenPayload,
    query: Record<string, unknown> = {},
  ) {
    await this.access.ensureStoreAccess(storeId, user, 'manage_products');
    const priceGroup = await this.findPriceGroupInStoreOrThrow(
      priceGroupId,
      storeId,
    );
    const search = this.optionalSearch(query.search, 'search');
    const matchFilter = this.optionalSort(
      query.match,
      ['all', 'matches', 'mismatches'],
      'all',
      'match',
    );
    const pagination = this.parsePageLimit(query);

    const where: Prisma.ProductWhereInput = {
      storeId,
      priceGroupId,
      ...(search
        ? {
            OR: [
              { barcode: { contains: search, mode: 'insensitive' } },
              { name: { contains: search, mode: 'insensitive' } },
            ],
          }
        : {}),
    };

    const products = await this.prisma.product.findMany({
      where,
      orderBy: { name: 'asc' },
      include: { department: true },
    });
    const defaultCents = this.toCents(priceGroup.defaultUnitRetail);
    const items = products
      .map((product) => {
        const matchesDefaultUnitRetail =
          this.toCents(product.unitRetail) === defaultCents;

        return {
          id: product.id,
          productNumber: product.productNumber,
          barcode: product.barcode,
          name: product.name,
          departmentName: product.department?.name ?? null,
          unitRetail: product.unitRetail,
          defaultUnitRetail: priceGroup.defaultUnitRetail.toFixed(2),
          isActive: product.isActive,
          matchesDefaultUnitRetail,
        };
      })
      .filter((product) => {
        if (matchFilter === 'matches') return product.matchesDefaultUnitRetail;
        if (matchFilter === 'mismatches')
          return !product.matchesDefaultUnitRetail;
        return true;
      })
      .sort((a, b) => {
        if (a.matchesDefaultUnitRetail !== b.matchesDefaultUnitRetail) {
          return a.matchesDefaultUnitRetail ? 1 : -1;
        }

        return a.name.localeCompare(b.name);
      });

    return {
      items: items.slice(pagination.skip, pagination.skip + pagination.limit),
      total: items.length,
      page: pagination.page,
      limit: pagination.limit,
    };
  }

  async updatePriceGroup(
    id: string,
    body: Record<string, unknown>,
    user: AuthTokenPayload,
  ) {
    const priceGroup = await this.findPriceGroupOrThrow(id);
    return this.updateStorePriceGroup(priceGroup.storeId, id, body, user);
  }

  async deletePriceGroup(id: string, user: AuthTokenPayload) {
    const priceGroup = await this.findPriceGroupOrThrow(id);
    await this.access.ensureStoreAccess(
      priceGroup.storeId,
      user,
      'manage_products',
    );

    return this.runInTransaction(async (tx) => {
      const updated = await tx.priceGroup.update({
        where: { id },
        data: { isActive: false },
      });

      await this.audit.record(tx, {
        storeId: priceGroup.storeId,
        actorId: user.staffId,
        ownerId: user.type === 'owner' ? user.accountId : null,
        action: AuditAction.deactivate,
        entityType: AuditEntityType.price_group,
        entityId: updated.id,
        entityName: updated.name,
        summary: `Deactivated price group ${updated.name}`,
        before: priceGroup,
        after: updated,
      });

      return updated;
    });
  }

  async createProductCategory(
    body: Record<string, unknown>,
    user: AuthTokenPayload,
  ) {
    const storeId = this.requiredString(body.storeId, 'storeId');
    return this.createStoreCategory(storeId, body, user);
  }

  async listProductCategories(storeId: string, user: AuthTokenPayload) {
    await this.access.ensureStoreAccess(storeId, user, 'manage_products');

    const categories = await this.prisma.productCategory.findMany({
      where: {
        storeId,
        isActive: true,
        department: { isActive: true },
      },
      orderBy: [
        { department: { posDepartmentNumber: 'asc' } },
        { name: 'asc' },
      ],
      include: {
        department: true,
        _count: { select: { products: true } },
      },
    });

    return categories.map((category) =>
      this.serializeProductCategory(category),
    );
  }

  async listStoreCategories(
    storeId: string,
    user: AuthTokenPayload,
    query: Record<string, unknown> = {},
  ) {
    await this.access.ensureStoreAccess(storeId, user, 'manage_products');
    const active = this.optionalQueryBoolean(query.active, 'active');
    const search = this.optionalSearch(query.search, 'search');
    const departmentId = this.optionalString(
      query.departmentId,
      'departmentId',
    );
    const pagination = this.parsePageLimit(query);
    const where: Prisma.ProductCategoryWhereInput = {
      storeId,
      ...(active === undefined ? {} : { isActive: active }),
      ...(departmentId ? { departmentId } : {}),
      ...(search ? { name: { contains: search, mode: 'insensitive' } } : {}),
    };

    const [categories, total] = await Promise.all([
      this.prisma.productCategory.findMany({
        where,
        orderBy: [
          { department: { posDepartmentNumber: 'asc' } },
          { name: 'asc' },
        ],
        skip: pagination.skip,
        take: pagination.limit,
        include: {
          department: true,
          _count: { select: { products: true } },
        },
      }),
      this.prisma.productCategory.count({ where }),
    ]);

    return {
      items: categories.map((category) =>
        this.serializeProductCategory(category),
      ),
      total,
      page: pagination.page,
      limit: pagination.limit,
    };
  }

  async listPosCategories(storeId: string, user: AuthTokenPayload) {
    await this.access.ensureStoreAccess(storeId, user, 'manage_products');
    const categories = await this.prisma.productCategory.findMany({
      where: {
        storeId,
        isActive: true,
        departmentId: { not: null },
        department: { isActive: true, onPos: true },
      },
      orderBy: [
        { department: { posDepartmentNumber: 'asc' } },
        { name: 'asc' },
      ],
      include: {
        department: true,
        _count: { select: { products: true } },
      },
    });

    return categories.map((category) => ({
      categoryId: category.id,
      name: category.name,
      departmentId: category.departmentId,
      departmentName: category.department?.name ?? null,
      posDepartmentNumber: category.department?.posDepartmentNumber ?? null,
      productCount: category._count.products,
    }));
  }

  async createStoreCategory(
    storeId: string,
    body: Record<string, unknown>,
    user: AuthTokenPayload,
  ) {
    await this.access.ensureStoreAccess(storeId, user, 'manage_products');
    const dto = this.parseCreateCategoryBody(body);
    await this.ensureActiveDepartmentInStore(storeId, dto.departmentId);
    await this.ensureCategoryNameAvailable(storeId, dto.departmentId, dto.name);

    try {
      const category = await this.runInTransaction(async (tx) => {
        const created = await tx.productCategory.create({
          data: { ...dto, storeId },
          include: {
            department: true,
            _count: { select: { products: true } },
          },
        });

        await this.audit.record(tx, {
          storeId,
          actorId: user.staffId,
          ownerId: user.type === 'owner' ? user.accountId : null,
          action: AuditAction.create,
          entityType: AuditEntityType.product_category,
          entityId: created.id,
          entityName: created.name,
          summary: `Created product category ${created.name}`,
          after: created,
        });

        return created;
      });

      return this.serializeProductCategory(category);
    } catch (error) {
      this.handleSetupNameConflict(error, 'product category');
      throw error;
    }
  }

  async getStoreCategory(
    storeId: string,
    categoryId: string,
    user: AuthTokenPayload,
  ) {
    await this.access.ensureStoreAccess(storeId, user, 'manage_products');
    const category = await this.prisma.productCategory.findFirst({
      where: { id: categoryId, storeId },
      include: {
        department: true,
        _count: { select: { products: true } },
      },
    });

    if (!category) {
      throw new NotFoundException('Product category not found');
    }

    return this.serializeProductCategory(category);
  }

  async updateStoreCategory(
    storeId: string,
    categoryId: string,
    body: Record<string, unknown>,
    user: AuthTokenPayload,
  ) {
    await this.access.ensureStoreAccess(storeId, user, 'manage_products');
    const category = await this.findProductCategoryInStoreOrThrow(
      categoryId,
      storeId,
    );
    const data = this.parseUpdateCategoryBody(body);
    const nextDepartmentId = data.departmentId ?? category.departmentId;

    if (data.departmentId !== undefined) {
      await this.ensureActiveDepartmentInStore(storeId, data.departmentId);
      const mismatchedProductCount = await this.prisma.product.count({
        where: {
          storeId,
          productCategoryId: categoryId,
          departmentId: { not: data.departmentId },
        },
      });

      if (mismatchedProductCount > 0) {
        throw new BadRequestException(
          'Move products to the new department before changing this category department.',
        );
      }
    }

    if (data.name !== undefined && nextDepartmentId) {
      await this.ensureCategoryNameAvailable(
        storeId,
        nextDepartmentId,
        data.name,
        categoryId,
      );
    }

    try {
      const updated = await this.runInTransaction(async (tx) => {
        const updatedCategory = await tx.productCategory.update({
          where: { id: categoryId },
          data,
          include: {
            department: true,
            _count: { select: { products: true } },
          },
        });

        await this.audit.record(tx, {
          storeId,
          actorId: user.staffId,
          ownerId: user.type === 'owner' ? user.accountId : null,
          action: updatedCategory.isActive
            ? AuditAction.update
            : AuditAction.deactivate,
          entityType: AuditEntityType.product_category,
          entityId: updatedCategory.id,
          entityName: updatedCategory.name,
          summary: `Updated product category ${updatedCategory.name}`,
          before: category,
          after: updatedCategory,
        });

        return updatedCategory;
      });

      return this.serializeProductCategory(updated);
    } catch (error) {
      this.handleSetupNameConflict(error, 'product category');
      throw error;
    }
  }

  async listStoreCategoryProducts(
    storeId: string,
    categoryId: string,
    user: AuthTokenPayload,
    query: Record<string, unknown> = {},
  ) {
    await this.access.ensureStoreAccess(storeId, user, 'manage_products');
    await this.findProductCategoryInStoreOrThrow(categoryId, storeId);
    const search = this.optionalSearch(query.search, 'search');
    const pagination = this.parsePageLimit(query);
    const productNumber =
      search && this.isPositiveIntegerText(search) ? Number(search) : undefined;
    const where: Prisma.ProductWhereInput = {
      storeId,
      productCategoryId: categoryId,
      ...(search
        ? {
            OR: [
              { barcode: { contains: search, mode: 'insensitive' } },
              { name: { contains: search, mode: 'insensitive' } },
              ...(productNumber ? [{ productNumber }] : []),
            ],
          }
        : {}),
    };

    const [products, total] = await Promise.all([
      this.prisma.product.findMany({
        where,
        orderBy: [{ productNumber: 'asc' }, { name: 'asc' }],
        skip: pagination.skip,
        take: pagination.limit,
        include: { department: true },
      }),
      this.prisma.product.count({ where }),
    ]);

    return {
      items: products.map((product) => ({
        id: product.id,
        productNumber: product.productNumber,
        barcode: product.barcode,
        name: product.name,
        departmentName: product.department?.name ?? null,
        unitRetail: product.unitRetail,
        isActive: product.isActive,
      })),
      total,
      page: pagination.page,
      limit: pagination.limit,
    };
  }

  async updateProductCategory(
    id: string,
    body: Record<string, unknown>,
    user: AuthTokenPayload,
  ) {
    const productCategory = await this.findProductCategoryOrThrow(id);
    return this.updateStoreCategory(productCategory.storeId, id, body, user);
  }

  async deleteProductCategory(id: string, user: AuthTokenPayload) {
    const productCategory = await this.findProductCategoryOrThrow(id);
    await this.access.ensureStoreAccess(
      productCategory.storeId,
      user,
      'manage_products',
    );
    await this.ensureSetupTableNotInUse(
      { productCategoryId: id },
      'Product category is used by products and cannot be deleted',
    );

    return this.runInTransaction(async (tx) => {
      const updated = await tx.productCategory.update({
        where: { id },
        data: { isActive: false },
      });

      await this.audit.record(tx, {
        storeId: productCategory.storeId,
        actorId: user.staffId,
        ownerId: user.type === 'owner' ? user.accountId : null,
        action: AuditAction.deactivate,
        entityType: AuditEntityType.product_category,
        entityId: updated.id,
        entityName: updated.name,
        summary: `Deactivated product category ${updated.name}`,
        before: productCategory,
        after: updated,
      });

      return updated;
    });
  }

  async createTax(body: Record<string, unknown>, user: AuthTokenPayload) {
    const { storeId, ...taxBody } = body;
    return this.createStoreTax(
      this.requiredString(storeId, 'storeId'),
      taxBody,
      user,
      { rateInput: 'fraction', response: 'legacy' },
    );
  }

  async createStoreTax(
    storeId: string,
    body: Record<string, unknown>,
    user: AuthTokenPayload,
    options: TaxOperationOptions = {},
  ) {
    await this.access.ensureStoreAccess(storeId, user, 'manage_products');
    const dto = this.parseCreateTaxBody(body, options.rateInput ?? 'percent');
    await this.ensureTaxNameAvailable(storeId, dto.name);

    try {
      const tax = await this.runInTransaction(async (tx) => {
        const created = await tx.tax.create({ data: { storeId, ...dto } });

        await this.audit.record(tx, {
          storeId,
          actorId: user.staffId,
          ownerId: user.type === 'owner' ? user.accountId : null,
          action: AuditAction.create,
          entityType: AuditEntityType.tax,
          entityId: created.id,
          entityName: created.name,
          summary: `Created tax ${created.name}`,
          after: created,
        });

        return created;
      });
      return options.response === 'legacy'
        ? this.serializeTaxReference(tax)
        : this.serializeTax(tax);
    } catch (error) {
      this.handleSetupNameConflict(error, 'tax');
      throw error;
    }
  }

  async listTaxes(storeId: string, user: AuthTokenPayload) {
    await this.access.ensureStoreAccess(storeId, user, 'manage_products');

    const taxes = await this.prisma.tax.findMany({
      where: { storeId, isActive: true },
      orderBy: { name: 'asc' },
    });

    return taxes.map((tax) => this.serializeTaxReference(tax));
  }

  async listStoreTaxes(
    storeId: string,
    user: AuthTokenPayload,
    query: Record<string, unknown> = {},
  ) {
    await this.access.ensureStoreAccess(storeId, user, 'manage_products');
    const active = this.optionalQueryBoolean(query.active, 'active');
    const search = this.optionalSearch(query.search, 'search');
    const sort = this.optionalSort(
      query.sort,
      ['name', 'rate', 'surchargeAmount', 'createdAt', 'updatedAt'],
      'name',
      'sort',
    );
    const order = this.optionalSort(
      query.order,
      ['asc', 'desc'],
      'asc',
      'order',
    );
    const pagination = this.parsePageLimit(query);
    const where: Prisma.TaxWhereInput = {
      storeId,
      ...(active === undefined ? {} : { isActive: active }),
      ...(search ? { name: { contains: search, mode: 'insensitive' } } : {}),
    };
    const orderBy =
      sort === 'name' && order === 'asc'
        ? [{ isActive: 'desc' as const }, { name: 'asc' as const }]
        : [{ [sort]: order }, { name: 'asc' as const }];

    const [taxes, total] = await Promise.all([
      this.prisma.tax.findMany({
        where,
        orderBy,
        skip: pagination.skip,
        take: pagination.limit,
        include: { _count: { select: { departments: true } } },
      }),
      this.prisma.tax.count({ where }),
    ]);

    return {
      items: taxes.map((tax) => this.serializeTax(tax)),
      total,
      page: pagination.page,
      limit: pagination.limit,
    };
  }

  async getStoreTax(storeId: string, taxId: string, user: AuthTokenPayload) {
    await this.access.ensureStoreAccess(storeId, user, 'manage_products');
    const tax = await this.prisma.tax.findFirst({
      where: { id: taxId, storeId },
      include: { _count: { select: { departments: true } } },
    });

    if (!tax) {
      throw new NotFoundException('Tax not found');
    }

    return this.serializeTax(tax);
  }

  async updateTax(
    id: string,
    body: Record<string, unknown>,
    user: AuthTokenPayload,
  ) {
    const tax = await this.findTaxOrThrow(id);
    return this.updateStoreTax(tax.storeId, id, body, user, {
      rateInput: 'fraction',
      response: 'legacy',
    });
  }

  async updateStoreTax(
    storeId: string,
    taxId: string,
    body: Record<string, unknown>,
    user: AuthTokenPayload,
    options: TaxOperationOptions = {},
  ) {
    await this.access.ensureStoreAccess(storeId, user, 'manage_products');
    const tax = await this.prisma.tax.findFirst({
      where: { id: taxId, storeId },
      include: { _count: { select: { departments: true } } },
    });

    if (!tax) {
      throw new NotFoundException('Tax not found');
    }

    const data = this.parseUpdateTaxBody(body, options.rateInput ?? 'percent');

    if (data.name !== undefined) {
      await this.ensureTaxNameAvailable(storeId, data.name, tax.id);
    }

    try {
      const updated = await this.runInTransaction(async (tx) => {
        const updatedTax = await tx.tax.update({
          where: { id: tax.id },
          data,
          include: { _count: { select: { departments: true } } },
        });

        await this.audit.record(tx, {
          storeId,
          actorId: user.staffId,
          ownerId: user.type === 'owner' ? user.accountId : null,
          action: updatedTax.isActive
            ? AuditAction.update
            : AuditAction.deactivate,
          entityType: AuditEntityType.tax,
          entityId: updatedTax.id,
          entityName: updatedTax.name,
          summary: `Updated tax ${updatedTax.name}`,
          before: tax,
          after: updatedTax,
        });

        return updatedTax;
      });
      return options.response === 'legacy'
        ? this.serializeTaxReference(updated)
        : this.serializeTax(updated);
    } catch (error) {
      this.handleSetupNameConflict(error, 'tax');
      throw error;
    }
  }

  async deleteTax(id: string, user: AuthTokenPayload) {
    const tax = await this.findTaxOrThrow(id);
    await this.access.ensureStoreAccess(tax.storeId, user, 'manage_products');
    await this.ensureSetupTableNotInUse(
      { taxId: id },
      'Tax is used by products and cannot be deleted',
    );

    return this.runInTransaction(async (tx) => {
      const updated = await tx.tax.update({
        where: { id },
        data: { isActive: false },
      });

      await this.audit.record(tx, {
        storeId: tax.storeId,
        actorId: user.staffId,
        ownerId: user.type === 'owner' ? user.accountId : null,
        action: AuditAction.deactivate,
        entityType: AuditEntityType.tax,
        entityId: updated.id,
        entityName: updated.name,
        summary: `Deactivated tax ${updated.name}`,
        before: tax,
        after: updated,
      });

      return updated;
    });
  }

  async create(body: Record<string, unknown>, user: AuthTokenPayload) {
    const dto = this.parseCreateBody(body);
    await this.access.ensureStoreAccess(dto.storeId, user, 'manage_products');
    const relations = await this.validateRelationsForStore(dto.storeId, {
      departmentId: dto.departmentId,
      priceGroupId: dto.priceGroupId,
      productCategoryId: dto.productCategoryId,
    });
    const inherited = this.resolveDepartmentProductDefaults(
      relations.department,
    );
    const calculated = this.calculateProductFields(dto);

    try {
      const product = await this.runInTransaction(async (tx) => {
        const updatedStore = await tx.store.update({
          where: { id: dto.storeId },
          data: { nextProductNumber: { increment: 1 } },
          select: { nextProductNumber: true },
        });
        const productNumber = updatedStore.nextProductNumber - 1;
        const product = await tx.product.create({
          data: {
            ...dto,
            productNumber,
            ...inherited,
            ...calculated,
            defaultMargin: dto.defaultMargin ?? inherited.defaultMargin,
          },
          include: this.productInclude,
        });

        if (product.currentQuantity !== 0) {
          await this.createInventoryLog(tx, {
            storeId: product.storeId,
            productId: product.id,
            performedByStaffId: user.staffId,
            actionType: InventoryActionType.manual_edit,
            quantityBefore: 0,
            quantityChanged: product.currentQuantity,
            quantityAfter: product.currentQuantity,
            reason: 'initial_quantity',
          });
        }

        await this.audit.record(tx, {
          storeId: product.storeId,
          actorId: user.staffId,
          ownerId: user.type === 'owner' ? user.accountId : null,
          action: AuditAction.create,
          entityType: AuditEntityType.product,
          entityId: product.id,
          entityName: product.name,
          summary: `Created product ${product.name}`,
          after: product,
        });

        return product;
      });
      await this.safeRecountPriceGroups([product.priceGroupId]);
      return product;
    } catch (error) {
      this.handleBarcodeConflict(error);
      throw error;
    }
  }

  createForStore(
    storeId: string,
    body: Record<string, unknown>,
    user: AuthTokenPayload,
  ) {
    return this.create({ ...body, storeId }, user);
  }

  async update(
    productId: string,
    body: Record<string, unknown>,
    user: AuthTokenPayload,
  ) {
    const product = await this.findActiveProductOrThrow(productId);
    await this.access.ensureStoreAccess(
      product.storeId,
      user,
      'manage_products',
    );
    const dto = this.parseUpdateBody(body);
    const next = { ...product, ...dto };

    const relationIds = {
      departmentId: next.departmentId,
      priceGroupId: next.priceGroupId,
      productCategoryId: next.productCategoryId,
    };
    const relations = await this.validateRelationsForStore(
      product.storeId,
      relationIds,
    );
    const calculated = this.calculateProductFields(next);
    const data: Prisma.ProductUncheckedUpdateInput = {
      ...dto,
      ...calculated,
    };

    if (dto.departmentId !== undefined) {
      const inherited = this.resolveDepartmentProductDefaults(
        relations.department,
      );
      data.taxId = inherited.taxId;
      if (dto.allowEbt === undefined) data.allowEbt = inherited.allowEbt;
      if (dto.trackInventory === undefined)
        data.trackInventory = inherited.trackInventory;
      if (dto.allowNegativeInventory === undefined)
        data.allowNegativeInventory = inherited.allowNegativeInventory;
      if (dto.minimumAge === undefined) data.minimumAge = inherited.minimumAge;
      if (dto.defaultMargin === undefined)
        data.defaultMargin = inherited.defaultMargin;
    }

    try {
      const updated = await this.runInTransaction(async (tx) => {
        const updated = await tx.product.update({
          where: { id: productId },
          data,
          include: this.productInclude,
        });

        if (
          dto.currentQuantity !== undefined &&
          dto.currentQuantity !== product.currentQuantity
        ) {
          await this.createInventoryLog(tx, {
            storeId: product.storeId,
            productId,
            performedByStaffId: user.staffId,
            actionType: InventoryActionType.manual_edit,
            quantityBefore: product.currentQuantity,
            quantityChanged: dto.currentQuantity - product.currentQuantity,
            quantityAfter: dto.currentQuantity,
            reason: 'manual_edit',
          });
        }

        await this.audit.record(tx, {
          storeId: product.storeId,
          actorId: user.staffId,
          ownerId: user.type === 'owner' ? user.accountId : null,
          action: updated.isActive
            ? AuditAction.update
            : AuditAction.deactivate,
          entityType: AuditEntityType.product,
          entityId: updated.id,
          entityName: updated.name,
          summary: `Updated product ${updated.name}`,
          before: product,
          after: updated,
        });

        return updated;
      });
      if (
        dto.priceGroupId !== undefined ||
        dto.unitRetail !== undefined ||
        dto.isActive !== undefined
      ) {
        await this.safeRecountPriceGroups([
          product.priceGroupId,
          updated.priceGroupId,
        ]);
      }
      return updated;
    } catch (error) {
      this.handleBarcodeConflict(error);
      throw error;
    }
  }

  async updateForStore(
    storeId: string,
    productId: string,
    body: Record<string, unknown>,
    user: AuthTokenPayload,
  ) {
    const product = await this.findActiveProductOrThrow(productId);

    if (product.storeId !== storeId) {
      throw new NotFoundException('Product not found');
    }

    return this.update(productId, body, user);
  }

  async findOne(productId: string, user: AuthTokenPayload) {
    const product = await this.findActiveProductOrThrow(productId);
    await this.access.ensureStoreAccess(
      product.storeId,
      user,
      'manage_products',
    );

    return this.prisma.product.findUnique({
      where: { id: productId },
      include: this.productInclude,
    });
  }

  async listByStore(storeId: string, user: AuthTokenPayload) {
    await this.access.ensureStoreAccess(storeId, user, 'manage_products');

    return this.prisma.product.findMany({
      where: { storeId, isActive: true },
      orderBy: { name: 'asc' },
      include: this.productInclude,
    });
  }

  async listStoreProducts(
    storeId: string,
    query: Record<string, unknown>,
    user: AuthTokenPayload,
  ) {
    await this.access.ensureStoreAccess(storeId, user, 'manage_products');
    const search = this.optionalSearch(query.search, 'search');
    const departmentId = this.optionalString(
      query.departmentId,
      'departmentId',
    );
    const categoryId = this.optionalString(query.categoryId, 'categoryId');
    const rawPriceGroupId = this.optionalString(
      query.priceGroupId,
      'priceGroupId',
    );
    const isActive = this.optionalQueryBoolean(query.isActive, 'isActive');
    const trackInventory = this.optionalQueryBoolean(
      query.trackInventory,
      'trackInventory',
    );
    const marginStatus = this.optionalMarginStatus(query.marginStatus);
    const sort = this.optionalSort(
      query.sort,
      PRICE_BOOK_SORT_FIELDS,
      'productNumber',
      'sort',
    );
    const order = this.optionalSort(
      query.order,
      ['asc', 'desc'],
      'asc',
      'order',
    );
    const pagination = this.parsePriceBookPagination(query);
    const productNumber =
      search && this.isPositiveIntegerText(search) ? Number(search) : null;
    const priceGroupId =
      rawPriceGroupId === '__none__' ? null : rawPriceGroupId;

    const where: Prisma.ProductWhereInput = {
      storeId,
      ...(departmentId ? { departmentId } : {}),
      ...(categoryId ? { productCategoryId: categoryId } : {}),
      ...(rawPriceGroupId
        ? rawPriceGroupId === '__none__'
          ? { priceGroupId: null }
          : { priceGroupId }
        : {}),
      ...(isActive === undefined ? {} : { isActive }),
      ...(trackInventory === undefined ? {} : { trackInventory }),
      ...this.buildMarginWhere(marginStatus),
      ...(search
        ? {
            OR: [
              ...(productNumber ? [{ productNumber }] : []),
              { barcode: search },
              { barcode: { contains: search, mode: 'insensitive' } },
              { name: { contains: search, mode: 'insensitive' } },
              { nacsCode: { contains: search, mode: 'insensitive' } },
              {
                department: { name: { contains: search, mode: 'insensitive' } },
              },
              {
                productCategory: {
                  name: { contains: search, mode: 'insensitive' },
                },
              },
              {
                priceGroup: {
                  name: { contains: search, mode: 'insensitive' },
                },
              },
            ],
          }
        : {}),
    };

    const [items, total] = await Promise.all([
      this.prisma.product.findMany({
        where,
        select: this.priceBookProductSelect,
        orderBy: this.priceBookOrderBy(sort, order),
        skip: pagination.skip,
        take: pagination.limit,
      }),
      this.prisma.product.count({ where }),
    ]);

    return {
      items: items.map((product) => this.serializePriceBookProduct(product)),
      total,
      page: pagination.page,
      limit: pagination.limit,
      totalPages: Math.max(1, Math.ceil(total / pagination.limit)),
    };
  }

  async listInventoryOverview(
    storeId: string,
    query: Record<string, unknown>,
    user: AuthTokenPayload,
  ) {
    await this.ensureInventoryOverviewAccess(storeId, user);
    const range = this.normalizeInventoryOverviewRange(query.range);
    const generatedAt = new Date();
    const salesWindow = this.getTrailingWindow(
      generatedAt,
      this.rangeToDays(range),
    );
    const deadStockWindow = this.getTrailingWindow(
      generatedAt,
      DEAD_STOCK_LOOKBACK_DAYS,
    );
    const deadStockGraceCutoff = this.addDays(
      this.startOfDay(generatedAt),
      -DEAD_STOCK_AGE_GRACE_DAYS,
    );

    const [activeProducts, salesInRange] = await Promise.all([
      this.prisma.product.findMany({
        where: {
          storeId,
          isActive: true,
        },
        select: this.inventoryOverviewProductSelect,
        orderBy: [{ productNumber: 'asc' }, { name: 'asc' }],
      }),
      this.prisma.transactionItem.groupBy({
        by: ['productId'],
        where: {
          transaction: this.completedPaidTransactionWhere(storeId, salesWindow),
        },
        _sum: {
          quantity: true,
          lineSubtotal: true,
        },
        _max: {
          createdAt: true,
        },
      }),
    ]);

    const trackedProducts = activeProducts.filter(
      (product) => product.trackInventory,
    );
    const activeProductMap = new Map(
      activeProducts.map((product) => [product.id, product] as const),
    );
    const salesByProductId = new Map(
      salesInRange.map((sale) => [
        sale.productId,
        {
          unitsSold: sale._sum.quantity ?? 0,
          grossSales: this.decimalOrZero(sale._sum.lineSubtotal),
          lastSaleAt: sale._max.createdAt,
        },
      ]),
    );

    const deadStockCandidates = trackedProducts.filter(
      (product) =>
        product.currentQuantity > 0 &&
        product.createdAt <= deadStockGraceCutoff,
    );
    const deadStockCandidateIds = deadStockCandidates.map(
      (product) => product.id,
    );

    const [recentDeadStockSales, allTimeDeadStockSales] =
      deadStockCandidateIds.length > 0
        ? await Promise.all([
            this.prisma.transactionItem.groupBy({
              by: ['productId'],
              where: {
                productId: { in: deadStockCandidateIds },
                transaction: this.completedPaidTransactionWhere(
                  storeId,
                  deadStockWindow,
                ),
              },
              _sum: { quantity: true },
            }),
            this.prisma.transactionItem.groupBy({
              by: ['productId'],
              where: {
                productId: { in: deadStockCandidateIds },
                transaction: {
                  storeId,
                  transactionStatus: TransactionStatus.completed,
                  paymentStatus: PaymentStatus.paid,
                },
              },
              _max: { createdAt: true },
            }),
          ])
        : [[], []];

    const recentDeadStockSalesSet = new Set(
      recentDeadStockSales.map((sale) => sale.productId),
    );
    const allTimeDeadStockSalesMap = new Map(
      allTimeDeadStockSales.map((sale) => [
        sale.productId,
        sale._max.createdAt,
      ]),
    );

    const inventoryValue = trackedProducts.reduce((total, product) => {
      if (product.currentQuantity <= 0) {
        return total;
      }

      const cost = this.getAuthoritativeUnitCost(product);
      if (!cost) {
        return total;
      }

      return total.add(cost.mul(product.currentQuantity));
    }, new Prisma.Decimal(0));

    const missingCostCount = trackedProducts.filter(
      (product) =>
        product.currentQuantity > 0 && !this.getAuthoritativeUnitCost(product),
    ).length;

    const lowStockProducts = trackedProducts
      .filter(
        (product) =>
          typeof product.minInventory === 'number' &&
          product.currentQuantity <= product.minInventory,
      )
      .sort((left, right) => {
        const leftShortage = (left.minInventory ?? 0) - left.currentQuantity;
        const rightShortage = (right.minInventory ?? 0) - right.currentQuantity;
        return (
          rightShortage - leftShortage ||
          left.currentQuantity - right.currentQuantity ||
          left.name.localeCompare(right.name)
        );
      });

    const outOfStockProducts = trackedProducts.filter(
      (product) => product.currentQuantity <= 0,
    );

    const alertCounts = {
      outOfStock: outOfStockProducts.filter(
        (product) => product.currentQuantity === 0,
      ).length,
      lowStock: lowStockProducts.filter(
        (product) => product.currentQuantity > 0,
      ).length,
      negativeInventory: trackedProducts.filter(
        (product) => product.currentQuantity < 0,
      ).length,
      missingCost: trackedProducts.filter(
        (product) => !this.getAuthoritativeUnitCost(product),
      ).length,
      missingMinimumInventory: trackedProducts.filter(
        (product) => product.minInventory === null,
      ).length,
    };

    const alerts = trackedProducts
      .flatMap((product) => this.buildInventoryAlerts(product))
      .sort(
        (left, right) =>
          left.priority - right.priority ||
          left.productName.localeCompare(right.productName),
      )
      .slice(0, INVENTORY_OVERVIEW_LIMIT)
      .map((entry) => {
        const { priority, ...alert } = entry;
        void priority;
        return alert;
      });

    const topSellers = salesInRange
      .map((sale) => {
        const product = activeProductMap.get(sale.productId);
        if (!product) {
          return null;
        }

        return {
          productId: product.id,
          productNumber: product.productNumber,
          productName: product.name,
          currentQuantity: product.currentQuantity,
          unitsSold: sale._sum.quantity ?? 0,
          grossSales: this.decimalOrZero(sale._sum.lineSubtotal),
        };
      })
      .filter((item): item is NonNullable<typeof item> => item !== null)
      .sort(
        (left, right) =>
          right.unitsSold - left.unitsSold ||
          right.grossSales.comparedTo(left.grossSales) ||
          left.productName.localeCompare(right.productName),
      )
      .slice(0, INVENTORY_OVERVIEW_LIMIT)
      .map((item, index) => ({
        rank: index + 1,
        productId: item.productId,
        productNumber: item.productNumber,
        productName: item.productName,
        currentQuantity: item.currentQuantity,
        unitsSold: item.unitsSold,
        grossSales: item.grossSales.toFixed(2),
      }));

    const slowSellers = activeProducts
      .map((product) => {
        const sale = salesByProductId.get(product.id);
        return {
          productId: product.id,
          productNumber: product.productNumber,
          productName: product.name,
          currentQuantity: product.currentQuantity,
          unitRetail: this.numberToFixed(product.unitRetail),
          unitsSold: sale?.unitsSold ?? 0,
          lastSaleAt: sale?.lastSaleAt ?? null,
        };
      })
      .sort((left, right) => {
        if (left.unitsSold !== right.unitsSold) {
          return left.unitsSold - right.unitsSold;
        }

        if (left.lastSaleAt && right.lastSaleAt) {
          return (
            left.lastSaleAt.getTime() - right.lastSaleAt.getTime() ||
            left.productName.localeCompare(right.productName)
          );
        }

        if (!left.lastSaleAt && right.lastSaleAt) {
          return -1;
        }

        if (left.lastSaleAt && !right.lastSaleAt) {
          return 1;
        }

        return left.productName.localeCompare(right.productName);
      })
      .slice(0, INVENTORY_OVERVIEW_LIMIT)
      .map((product) => ({
        ...product,
        lastSaleAt: product.lastSaleAt?.toISOString() ?? null,
      }));

    const deadStock = deadStockCandidates
      .filter((product) => !recentDeadStockSalesSet.has(product.id))
      .map((product) => {
        const lastSaleAt = allTimeDeadStockSalesMap.get(product.id) ?? null;
        const referenceDate = lastSaleAt ?? product.createdAt;
        return {
          productId: product.id,
          productNumber: product.productNumber,
          productName: product.name,
          currentQuantity: product.currentQuantity,
          inventoryValue:
            this.getAuthoritativeUnitCost(product)
              ?.mul(product.currentQuantity)
              .toFixed(2) ?? '0.00',
          lastSaleAt: lastSaleAt?.toISOString() ?? null,
          ageReferenceType: lastSaleAt ? 'last_sale' : 'created_at',
          ageReferenceDate: referenceDate.toISOString(),
          daysSinceLastSale: this.diffDays(generatedAt, referenceDate),
        };
      })
      .sort(
        (left, right) =>
          right.daysSinceLastSale - left.daysSinceLastSale ||
          Number(right.inventoryValue) - Number(left.inventoryValue) ||
          left.productName.localeCompare(right.productName),
      )
      .slice(0, INVENTORY_OVERVIEW_LIMIT);

    return {
      generatedAt: generatedAt.toISOString(),
      range,
      summary: {
        activeProductCount: activeProducts.length,
        lowStockCount: lowStockProducts.length,
        outOfStockCount: outOfStockProducts.length,
        inventoryValue: inventoryValue.toFixed(2),
        missingCostCount,
      },
      alertCounts,
      alerts,
      topSellers,
      slowSellers,
      deadStock,
      lowStock: lowStockProducts
        .slice(0, INVENTORY_OVERVIEW_LIMIT)
        .map((product) => ({
          productId: product.id,
          productNumber: product.productNumber,
          productName: product.name,
          currentQuantity: product.currentQuantity,
          minimumInventory: product.minInventory ?? 0,
          shortage: (product.minInventory ?? 0) - product.currentQuantity,
          departmentName: product.department?.name ?? null,
          status:
            product.currentQuantity < 0
              ? 'NEGATIVE_STOCK'
              : product.currentQuantity === 0
                ? 'OUT_OF_STOCK'
                : 'LOW_STOCK',
        })),
      rules: {
        deadStockLookbackDays: DEAD_STOCK_LOOKBACK_DAYS,
        deadStockAgeGraceDays: DEAD_STOCK_AGE_GRACE_DAYS,
      },
    };
  }

  async findByBarcode(
    storeId: string,
    barcode: string,
    user: AuthTokenPayload,
  ) {
    await this.access.ensureStoreAccess(storeId, user, 'manage_products');
    const product = await this.prisma.product.findFirst({
      where: {
        storeId,
        barcode: this.validateBarcode(barcode),
        isActive: true,
      },
      include: this.productInclude,
    });

    if (!product) {
      throw new NotFoundException('Product not found');
    }

    return product;
  }

  async getNextProductNumber(storeId: string, user: AuthTokenPayload) {
    await this.access.ensureStoreAccess(storeId, user, 'manage_products');
    const store = await this.prisma.store.findFirst({
      where: { id: storeId },
      select: { nextProductNumber: true },
    });

    if (!store) {
      throw new NotFoundException('Store not found');
    }

    return { nextProductNumber: store.nextProductNumber };
  }

  async findByProductNumber(
    storeId: string,
    productNumberValue: string,
    user: AuthTokenPayload,
  ) {
    await this.access.ensureStoreAccess(storeId, user, 'manage_products');
    const productNumber = this.requiredPositiveInt(
      productNumberValue,
      'productNumber',
    );
    const product = await this.prisma.product.findFirst({
      where: { storeId, productNumber, isActive: true },
      include: this.productInclude,
    });

    if (!product) {
      throw new NotFoundException('Product not found');
    }

    return product;
  }

  async findStoreProductById(
    storeId: string,
    productId: string,
    user: AuthTokenPayload,
  ) {
    await this.access.ensureStoreAccess(storeId, user, 'manage_products');
    const product = await this.prisma.product.findFirst({
      where: { id: productId, storeId },
      include: this.productInclude,
    });

    if (!product) {
      throw new NotFoundException('Product not found');
    }

    return product;
  }

  async remove(productId: string, user: AuthTokenPayload) {
    const product = await this.findActiveProductOrThrow(productId);
    await this.access.ensureStoreAccess(
      product.storeId,
      user,
      'manage_products',
    );

    const removed = await this.runInTransaction(async (tx) => {
      const updated = await tx.product.update({
        where: { id: productId },
        data: { isActive: false },
        include: this.productInclude,
      });

      await this.audit.record(tx, {
        storeId: product.storeId,
        actorId: user.staffId,
        ownerId: user.type === 'owner' ? user.accountId : null,
        action: AuditAction.deactivate,
        entityType: AuditEntityType.product,
        entityId: updated.id,
        entityName: updated.name,
        summary: `Deactivated product ${updated.name}`,
        before: product,
        after: updated,
      });

      return updated;
    });
    await this.safeRecountPriceGroups([product.priceGroupId]);
    return removed;
  }

  async receiveInventory(
    body: Record<string, unknown>,
    user: AuthTokenPayload,
  ) {
    const dto = this.parseReceiveInventoryBody(body);
    await this.access.ensureStoreAccess(dto.storeId, user, 'manage_inventory');

    return this.runInTransaction(async (tx) => {
      const updatedProducts: unknown[] = [];

      for (const item of dto.items) {
        const product = await this.findActiveProductInStoreOrThrow(
          tx,
          item.productId,
          dto.storeId,
        );
        const quantityAfter = product.currentQuantity + item.quantity;
        const costUpdates =
          item.caseCost === undefined
            ? {}
            : {
                caseCost: item.caseCost,
                ...this.calculateProductFields({
                  ...product,
                  caseCost: item.caseCost,
                }),
              };

        const updated = await tx.product.update({
          where: { id: product.id },
          data: {
            currentQuantity: quantityAfter,
            ...costUpdates,
          },
          include: this.productInclude,
        });

        await this.createInventoryLog(tx, {
          storeId: dto.storeId,
          productId: product.id,
          performedByStaffId: user.staffId,
          actionType: InventoryActionType.receive,
          quantityBefore: product.currentQuantity,
          quantityChanged: item.quantity,
          quantityAfter,
          reason: 'inventory_receive',
          notes: item.notes,
          referenceType: item.referenceId ? 'invoice' : undefined,
          referenceId: item.referenceId,
        });

        await this.audit.record(tx, {
          storeId: dto.storeId,
          actorId: user.staffId,
          ownerId: user.type === 'owner' ? user.accountId : null,
          action: AuditAction.update,
          entityType: AuditEntityType.inventory,
          entityId: product.id,
          entityName: product.name,
          summary: `Received ${item.quantity} units for ${product.name}`,
          before: product,
          after: updated,
          metadata: {
            actionType: InventoryActionType.receive,
            quantityChanged: item.quantity,
            referenceId: item.referenceId,
          },
        });

        updatedProducts.push(updated);
      }

      return updatedProducts;
    });
  }

  async adjustInventory(body: Record<string, unknown>, user: AuthTokenPayload) {
    const dto = this.parseAdjustInventoryBody(body);
    await this.access.ensureStoreAccess(dto.storeId, user, 'manage_inventory');

    return this.runInTransaction(async (tx) => {
      const product = await this.findActiveProductInStoreOrThrow(
        tx,
        dto.productId,
        dto.storeId,
      );
      const quantityAfter = product.currentQuantity + dto.adjustment;

      if (quantityAfter < 0 && !product.allowNegativeInventory) {
        throw new BadRequestException('Inventory cannot go below zero');
      }

      const updated = await tx.product.update({
        where: { id: product.id },
        data: { currentQuantity: quantityAfter },
        include: this.productInclude,
      });

      await this.createInventoryLog(tx, {
        storeId: dto.storeId,
        productId: product.id,
        performedByStaffId: user.staffId,
        actionType: InventoryActionType.adjustment,
        quantityBefore: product.currentQuantity,
        quantityChanged: dto.adjustment,
        quantityAfter,
        reason: dto.reason,
        notes: dto.notes,
        referenceType: 'adjustment',
      });

      await this.audit.record(tx, {
        storeId: dto.storeId,
        actorId: user.staffId,
        ownerId: user.type === 'owner' ? user.accountId : null,
        action: AuditAction.update,
        entityType: AuditEntityType.inventory,
        entityId: product.id,
        entityName: product.name,
        summary: `Adjusted inventory for ${product.name}`,
        before: product,
        after: updated,
        metadata: {
          actionType: InventoryActionType.adjustment,
          quantityChanged: dto.adjustment,
          reason: dto.reason,
        },
      });

      return updated;
    });
  }

  async listInventoryLogsByStore(
    storeId: string,
    user: AuthTokenPayload,
    query: Record<string, unknown> = {},
  ) {
    await this.access.ensureStoreAccess(storeId, user, 'view_store');
    const pagination = this.parsePagination(query);

    return this.prisma.inventoryLog.findMany({
      where: { storeId },
      orderBy: { createdAt: 'desc' },
      skip: pagination.skip,
      take: pagination.take,
      include: this.inventoryLogInclude,
    });
  }

  async listInventoryLogsByProduct(
    productId: string,
    user: AuthTokenPayload,
    query: Record<string, unknown> = {},
  ) {
    const product = await this.prisma.product.findUnique({
      where: { id: productId },
      select: { storeId: true },
    });

    if (!product) {
      throw new NotFoundException('Product not found');
    }

    await this.access.ensureStoreAccess(product.storeId, user, 'view_store');
    const pagination = this.parsePagination(query);

    return this.prisma.inventoryLog.findMany({
      where: { productId },
      orderBy: { createdAt: 'desc' },
      skip: pagination.skip,
      take: pagination.take,
      include: this.inventoryLogInclude,
    });
  }

  async listLowStock(storeId: string, user: AuthTokenPayload) {
    await this.access.ensureStoreAccess(storeId, user, 'view_store');

    return this.prisma.product.findMany({
      where: {
        storeId,
        isActive: true,
        trackInventory: true,
        minInventory: { not: null },
        currentQuantity: { lte: this.prisma.product.fields.minInventory },
      },
      orderBy: { name: 'asc' },
      include: this.productInclude,
    });
  }

  async listOutOfStock(storeId: string, user: AuthTokenPayload) {
    await this.access.ensureStoreAccess(storeId, user, 'view_store');

    return this.prisma.product.findMany({
      where: {
        storeId,
        isActive: true,
        trackInventory: true,
        currentQuantity: { lte: 0 },
      },
      orderBy: { name: 'asc' },
      include: this.productInclude,
    });
  }

  private async findActiveProductInStoreOrThrow(
    tx: Prisma.TransactionClient,
    productId: string,
    storeId: string,
  ) {
    const product = await tx.product.findFirst({
      where: { id: productId, storeId, isActive: true },
    });

    if (!product) {
      throw new NotFoundException('Product not found');
    }

    return product;
  }

  private runInTransaction<T>(
    callback: (tx: Prisma.TransactionClient) => Promise<T>,
  ) {
    if (typeof this.prisma.$transaction === 'function') {
      return this.prisma.$transaction(callback);
    }

    return callback(this.prisma);
  }

  private createInventoryLog(
    tx: Prisma.TransactionClient,
    data: {
      storeId: string;
      productId: string;
      performedByStaffId: string;
      actionType: InventoryActionType;
      quantityBefore: number;
      quantityChanged: number;
      quantityAfter: number;
      reason: string;
      notes?: string | null;
      referenceType?: string | null;
      referenceId?: string | null;
    },
  ) {
    return tx.inventoryLog.create({ data });
  }

  private async findDepartmentOrThrow(id: string) {
    const department = await this.prisma.department.findUnique({
      where: { id },
    });

    if (!department) {
      throw new NotFoundException('Department not found');
    }

    return department;
  }

  private async findDepartmentInStoreOrThrow(id: string, storeId: string) {
    const department = await this.prisma.department.findFirst({
      where: { id, storeId },
    });

    if (!department) {
      throw new NotFoundException('Department not found');
    }

    return department;
  }

  private async findPriceGroupOrThrow(id: string) {
    const priceGroup = await this.prisma.priceGroup.findUnique({
      where: { id },
    });

    if (!priceGroup) {
      throw new NotFoundException('Price group not found');
    }

    return priceGroup;
  }

  private async findPriceGroupInStoreOrThrow(id: string, storeId: string) {
    const priceGroup = await this.prisma.priceGroup.findFirst({
      where: { id, storeId },
    });

    if (!priceGroup) {
      throw new NotFoundException('Price group not found');
    }

    return priceGroup;
  }

  private async findProductCategoryOrThrow(id: string) {
    const productCategory = await this.prisma.productCategory.findUnique({
      where: { id },
    });

    if (!productCategory) {
      throw new NotFoundException('Product category not found');
    }

    return productCategory;
  }

  private async findProductCategoryInStoreOrThrow(id: string, storeId: string) {
    const productCategory = await this.prisma.productCategory.findFirst({
      where: { id, storeId },
    });

    if (!productCategory) {
      throw new NotFoundException('Product category not found');
    }

    return productCategory;
  }

  private async findTaxOrThrow(id: string) {
    const tax = await this.prisma.tax.findUnique({
      where: { id },
    });

    if (!tax) {
      throw new NotFoundException('Tax not found');
    }

    return tax;
  }

  private async ensureSetupTableNotInUse(
    where: Prisma.ProductWhereInput,
    message: string,
  ) {
    const productCount = await this.prisma.product.count({
      where: { ...where, isActive: true },
    });

    if (productCount > 0) {
      throw new BadRequestException(message);
    }
  }

  private async findActiveProductOrThrow(productId: string) {
    const product = await this.prisma.product.findFirst({
      where: { id: productId, isActive: true },
    });

    if (!product) {
      throw new NotFoundException('Product not found');
    }

    return product;
  }

  private async validateRelationsForStore(
    storeId: string,
    ids: {
      departmentId: string;
      priceGroupId?: string | null;
      productCategoryId?: string | null;
    },
  ) {
    const [department, priceGroup, productCategory] = await Promise.all([
      this.prisma.department.findFirst({
        where: { id: ids.departmentId, storeId, isActive: true },
        include: { defaultTax: true },
      }),
      this.prisma.priceGroup.findFirst({
        where: ids.priceGroupId
          ? { id: ids.priceGroupId, storeId, isActive: true }
          : { id: '__optional_price_group_not_selected__' },
      }),
      this.prisma.productCategory.findFirst({
        where: ids.productCategoryId
          ? { id: ids.productCategoryId, storeId, isActive: true }
          : { id: '__optional_category_not_selected__' },
        include: { department: true },
      }),
    ]);

    if (!department) {
      throw new BadRequestException(
        'departmentId must belong to the product store',
      );
    }

    if (ids.priceGroupId && !priceGroup) {
      throw new BadRequestException(
        'priceGroupId must belong to the product store',
      );
    }

    if (ids.productCategoryId && !productCategory) {
      throw new BadRequestException(
        'productCategoryId must belong to the product store',
      );
    }

    if (productCategory && productCategory.departmentId !== ids.departmentId) {
      throw new BadRequestException(
        'The selected category does not belong to the selected department.',
      );
    }

    if (!department.defaultTaxId || !department.defaultTax?.isActive) {
      throw new BadRequestException(
        'Department must have an active default tax before assigning products',
      );
    }

    return { department, priceGroup, productCategory };
  }

  private resolveDepartmentProductDefaults(
    department: Prisma.DepartmentGetPayload<{ include: { defaultTax: true } }>,
  ) {
    if (!department.defaultTaxId) {
      throw new BadRequestException(
        'Department must have a default tax before assigning products',
      );
    }

    return {
      taxId: department.defaultTaxId,
      allowEbt: department.allowEbt,
      trackInventory: department.trackInventory,
      allowNegativeInventory: department.allowNegativeInventorySales,
      minimumAge: this.departmentMinimumAgeToProductMinimumAge(
        department.minimumAge,
      ),
      defaultMargin:
        department.defaultRetailMargin === null
          ? null
          : Number(department.defaultRetailMargin),
    };
  }

  private departmentMinimumAgeToProductMinimumAge(
    minimumAge: DepartmentMinimumAge,
  ) {
    switch (minimumAge) {
      case DepartmentMinimumAge.age_18:
      case DepartmentMinimumAge.age_18_time_sensitive:
        return 18;
      case DepartmentMinimumAge.age_21:
      case DepartmentMinimumAge.age_21_time_sensitive:
        return 21;
      default:
        return null;
    }
  }

  private calculateProductFields(values: ProductCalculationInput) {
    const unitsPerCase = values.unitsPerCase;
    const caseCost = values.caseCost;
    const caseDiscount = values.caseDiscount ?? 0;
    const caseRebate = values.caseRebate ?? 0;

    if (
      !unitsPerCase ||
      unitsPerCase <= 0 ||
      caseCost === null ||
      caseCost === undefined
    ) {
      return {
        discountPerUnit: null,
        rebatePerUnit: null,
        unitCost: null,
        unitCostAfterDiscountAndRebate: null,
        margin: null,
      };
    }

    const discountPerUnit = caseDiscount / unitsPerCase;
    const rebatePerUnit = caseRebate / unitsPerCase;
    const unitCost = caseCost / unitsPerCase;
    const unitCostAfterDiscountAndRebate =
      unitCost - discountPerUnit - rebatePerUnit;
    const margin =
      values.unitRetail > 0
        ? ((values.unitRetail - unitCostAfterDiscountAndRebate) /
            values.unitRetail) *
          100
        : null;

    return {
      discountPerUnit,
      rebatePerUnit,
      unitCost,
      unitCostAfterDiscountAndRebate,
      margin,
    };
  }

  private async ensureInventoryOverviewAccess(
    storeId: string,
    user: AuthTokenPayload,
  ) {
    try {
      await this.access.ensureStoreAccess(
        storeId,
        user,
        StorePermissionKey.view_reports,
      );
    } catch (error) {
      if (!(error instanceof ForbiddenException)) {
        throw error;
      }

      await this.access.ensureStoreAccess(
        storeId,
        user,
        StorePermissionKey.view_store,
      );
    }
  }

  private normalizeInventoryOverviewRange(
    value: unknown,
  ): InventoryOverviewRange {
    if (
      typeof value === 'string' &&
      INVENTORY_OVERVIEW_RANGES.includes(value as InventoryOverviewRange)
    ) {
      return value as InventoryOverviewRange;
    }

    return DEFAULT_INVENTORY_OVERVIEW_RANGE;
  }

  private rangeToDays(range: InventoryOverviewRange) {
    switch (range) {
      case '7d':
        return 7;
      case '90d':
        return 90;
      default:
        return 30;
    }
  }

  private getTrailingWindow(now: Date, days: number) {
    const end = new Date(now);
    const start = this.startOfDay(this.addDays(now, -(days - 1)));
    return { start, end };
  }

  private startOfDay(value: Date) {
    const next = new Date(value);
    next.setHours(0, 0, 0, 0);
    return next;
  }

  private addDays(value: Date, days: number) {
    const next = new Date(value);
    next.setDate(next.getDate() + days);
    return next;
  }

  private diffDays(later: Date, earlier: Date) {
    return Math.max(
      0,
      Math.floor(
        (this.startOfDay(later).getTime() -
          this.startOfDay(earlier).getTime()) /
          86400000,
      ),
    );
  }

  private completedPaidTransactionWhere(
    storeId: string,
    window: { start: Date; end: Date },
  ): Prisma.TransactionWhereInput {
    return {
      storeId,
      transactionStatus: TransactionStatus.completed,
      paymentStatus: PaymentStatus.paid,
      createdAt: {
        gte: window.start,
        lte: window.end,
      },
    };
  }

  private getAuthoritativeUnitCost(product: InventoryOverviewProductRecord) {
    if (product.unitCostAfterDiscountAndRebate !== null) {
      return new Prisma.Decimal(product.unitCostAfterDiscountAndRebate);
    }

    if (product.unitCost !== null) {
      return new Prisma.Decimal(product.unitCost);
    }

    if (
      product.caseCost !== null &&
      product.unitsPerCase !== null &&
      product.unitsPerCase > 0
    ) {
      return new Prisma.Decimal(product.caseCost).div(product.unitsPerCase);
    }

    return null;
  }

  private buildInventoryAlerts(product: InventoryOverviewProductRecord) {
    const alerts: Array<{
      priority: number;
      productId: string;
      productNumber: number;
      productName: string;
      barcode: string;
      currentQuantity: number;
      minimumInventory: number | null;
      departmentName: string | null;
      type:
        | 'OUT_OF_STOCK'
        | 'LOW_STOCK'
        | 'NEGATIVE_STOCK'
        | 'MISSING_COST'
        | 'MISSING_MINIMUM_INVENTORY';
    }> = [];

    if (product.currentQuantity < 0) {
      alerts.push({
        priority: 0,
        productId: product.id,
        productNumber: product.productNumber,
        productName: product.name,
        barcode: product.barcode,
        currentQuantity: product.currentQuantity,
        minimumInventory: product.minInventory,
        departmentName: product.department?.name ?? null,
        type: 'NEGATIVE_STOCK',
      });
    } else if (product.currentQuantity === 0) {
      alerts.push({
        priority: 1,
        productId: product.id,
        productNumber: product.productNumber,
        productName: product.name,
        barcode: product.barcode,
        currentQuantity: product.currentQuantity,
        minimumInventory: product.minInventory,
        departmentName: product.department?.name ?? null,
        type: 'OUT_OF_STOCK',
      });
    } else if (
      product.minInventory !== null &&
      product.currentQuantity <= product.minInventory
    ) {
      alerts.push({
        priority: 2,
        productId: product.id,
        productNumber: product.productNumber,
        productName: product.name,
        barcode: product.barcode,
        currentQuantity: product.currentQuantity,
        minimumInventory: product.minInventory,
        departmentName: product.department?.name ?? null,
        type: 'LOW_STOCK',
      });
    }

    if (!this.getAuthoritativeUnitCost(product)) {
      alerts.push({
        priority: 3,
        productId: product.id,
        productNumber: product.productNumber,
        productName: product.name,
        barcode: product.barcode,
        currentQuantity: product.currentQuantity,
        minimumInventory: product.minInventory,
        departmentName: product.department?.name ?? null,
        type: 'MISSING_COST',
      });
    }

    if (product.minInventory === null) {
      alerts.push({
        priority: 4,
        productId: product.id,
        productNumber: product.productNumber,
        productName: product.name,
        barcode: product.barcode,
        currentQuantity: product.currentQuantity,
        minimumInventory: product.minInventory,
        departmentName: product.department?.name ?? null,
        type: 'MISSING_MINIMUM_INVENTORY',
      });
    }

    return alerts;
  }

  private decimalOrZero(value: Prisma.Decimal | number | null | undefined) {
    if (value === null || value === undefined) {
      return new Prisma.Decimal(0);
    }

    return value instanceof Prisma.Decimal ? value : new Prisma.Decimal(value);
  }

  private numberToFixed(value: number) {
    return new Prisma.Decimal(value).toFixed(2);
  }

  private parseReceiveInventoryBody(
    body: Record<string, unknown>,
  ): InventoryReceiveDto {
    const items = body.items;

    if (!Array.isArray(items) || items.length === 0) {
      throw new BadRequestException('items must contain at least one item');
    }

    return {
      storeId: this.requiredString(body.storeId, 'storeId'),
      items: items.map((item, index) => {
        if (!this.isObject(item)) {
          throw new BadRequestException(`items.${index} must be an object`);
        }

        return {
          productId: this.requiredString(
            item.productId,
            `items.${index}.productId`,
          ),
          quantity: this.requiredPositiveInt(
            item.quantity,
            `items.${index}.quantity`,
          ),
          caseCost:
            item.caseCost === undefined
              ? undefined
              : this.optionalNumber(item.caseCost, `items.${index}.caseCost`),
          referenceId:
            item.referenceId === undefined
              ? undefined
              : this.optionalString(
                  item.referenceId,
                  `items.${index}.referenceId`,
                ),
          notes:
            item.notes === undefined
              ? undefined
              : this.optionalString(item.notes, `items.${index}.notes`),
        };
      }),
    };
  }

  private parseAdjustInventoryBody(
    body: Record<string, unknown>,
  ): InventoryAdjustmentDto {
    return {
      storeId: this.requiredString(body.storeId, 'storeId'),
      productId: this.requiredString(body.productId, 'productId'),
      adjustment: this.requiredNonZeroInt(body.adjustment, 'adjustment'),
      reason: this.requiredString(body.reason, 'reason'),
      notes:
        body.notes === undefined
          ? undefined
          : this.optionalString(body.notes, 'notes'),
    };
  }

  private parseCreateBody(body: Record<string, unknown>): ProductCreateDto {
    if (body.productNumber !== undefined) {
      throw new BadRequestException('productNumber is assigned automatically');
    }

    return {
      storeId: this.requiredString(body.storeId, 'storeId'),
      barcode: this.validateBarcode(body.barcode),
      name: this.requiredString(body.name, 'name'),
      departmentId: this.requiredString(body.departmentId, 'departmentId'),
      priceGroupId: this.optionalString(body.priceGroupId, 'priceGroupId'),
      productCategoryId: this.optionalString(
        body.productCategoryId,
        'productCategoryId',
      ),
      saleType: this.requiredEnum(body.saleType, 'saleType', ProductSaleType),
      currentQuantity:
        this.optionalInt(body.currentQuantity, 'currentQuantity') ?? 0,
      unitsPerCase: this.requiredPositiveInt(body.unitsPerCase, 'unitsPerCase'),
      caseCost: this.optionalNumber(body.caseCost, 'caseCost'),
      caseDiscount: this.optionalNumber(body.caseDiscount, 'caseDiscount') ?? 0,
      caseRebate: this.optionalNumber(body.caseRebate, 'caseRebate') ?? 0,
      unitRetail: this.requiredNumber(body.unitRetail, 'unitRetail'),
      onlineRetailPrice: this.optionalNumber(
        body.onlineRetailPrice,
        'onlineRetailPrice',
      ),
      unitOfMeasure: this.optionalString(body.unitOfMeasure, 'unitOfMeasure'),
      size: this.optionalString(body.size, 'size'),
      defaultMargin: this.optionalNumber(body.defaultMargin, 'defaultMargin'),
      maxInventory: this.optionalInt(body.maxInventory, 'maxInventory'),
      minInventory: this.optionalInt(body.minInventory, 'minInventory'),
      minimumAge: this.optionalInt(body.minimumAge, 'minimumAge'),
      taxId: this.optionalString(body.taxId, 'taxId') ?? '',
      nacsCode: this.optionalString(body.nacsCode, 'nacsCode'),
      nacsCategory: this.optionalString(body.nacsCategory, 'nacsCategory'),
      nacsSubCategory: this.optionalString(
        body.nacsSubCategory,
        'nacsSubCategory',
      ),
      blueLaw: this.optionalBoolean(body.blueLaw, 'blueLaw', false) ?? false,
      linkedItems: this.optionalJson(body.linkedItems),
      kitchenPrint:
        this.optionalBoolean(body.kitchenPrint, 'kitchenPrint', false) ?? false,
      allowEbt: this.optionalBoolean(body.allowEbt, 'allowEbt'),
      trackInventory:
        this.optionalBoolean(body.trackInventory, 'trackInventory', true) ??
        true,
      allowNegativeInventory:
        this.optionalBoolean(
          body.allowNegativeInventory,
          'allowNegativeInventory',
          false,
        ) ?? false,
      taxStyle: this.requiredEnum(body.taxStyle, 'taxStyle', TaxStyle),
      isActive: this.optionalBoolean(body.isActive, 'isActive', true) ?? true,
    };
  }

  private parseUpdateBody(body: Record<string, unknown>): ProductUpdateDto {
    const updates: ProductUpdateDto = {};

    if (body.productNumber !== undefined) {
      throw new BadRequestException('productNumber cannot be changed');
    }

    if (body.barcode !== undefined)
      updates.barcode = this.validateBarcode(body.barcode);
    if (body.name !== undefined)
      updates.name = this.requiredString(body.name, 'name');
    if (body.departmentId !== undefined)
      updates.departmentId = this.requiredString(
        body.departmentId,
        'departmentId',
      );
    if (body.priceGroupId !== undefined)
      updates.priceGroupId = this.optionalString(
        body.priceGroupId,
        'priceGroupId',
      );
    if (body.productCategoryId !== undefined)
      updates.productCategoryId = this.optionalString(
        body.productCategoryId,
        'productCategoryId',
      );
    if (body.saleType !== undefined)
      updates.saleType = this.requiredEnum(
        body.saleType,
        'saleType',
        ProductSaleType,
      );
    if (body.currentQuantity !== undefined)
      updates.currentQuantity = this.requiredInt(
        body.currentQuantity,
        'currentQuantity',
      );
    if (body.unitsPerCase !== undefined)
      updates.unitsPerCase = this.requiredPositiveInt(
        body.unitsPerCase,
        'unitsPerCase',
      );
    if (body.caseCost !== undefined)
      updates.caseCost = this.optionalNumber(body.caseCost, 'caseCost');
    if (body.caseDiscount !== undefined)
      updates.caseDiscount = this.requiredNumber(
        body.caseDiscount,
        'caseDiscount',
      );
    if (body.caseRebate !== undefined)
      updates.caseRebate = this.requiredNumber(body.caseRebate, 'caseRebate');
    if (body.unitRetail !== undefined)
      updates.unitRetail = this.requiredNumber(body.unitRetail, 'unitRetail');
    if (body.onlineRetailPrice !== undefined)
      updates.onlineRetailPrice = this.optionalNumber(
        body.onlineRetailPrice,
        'onlineRetailPrice',
      );
    if (body.unitOfMeasure !== undefined)
      updates.unitOfMeasure = this.optionalString(
        body.unitOfMeasure,
        'unitOfMeasure',
      );
    if (body.size !== undefined)
      updates.size = this.optionalString(body.size, 'size');
    if (body.defaultMargin !== undefined)
      updates.defaultMargin = this.optionalNumber(
        body.defaultMargin,
        'defaultMargin',
      );
    if (body.maxInventory !== undefined)
      updates.maxInventory = this.optionalInt(
        body.maxInventory,
        'maxInventory',
      );
    if (body.minInventory !== undefined)
      updates.minInventory = this.optionalInt(
        body.minInventory,
        'minInventory',
      );
    if (body.minimumAge !== undefined)
      updates.minimumAge = this.optionalInt(body.minimumAge, 'minimumAge');
    if (body.taxId !== undefined)
      throw new BadRequestException('taxId is inherited from department');
    if (body.nacsCode !== undefined)
      updates.nacsCode = this.optionalString(body.nacsCode, 'nacsCode');
    if (body.nacsCategory !== undefined)
      updates.nacsCategory = this.optionalString(
        body.nacsCategory,
        'nacsCategory',
      );
    if (body.nacsSubCategory !== undefined)
      updates.nacsSubCategory = this.optionalString(
        body.nacsSubCategory,
        'nacsSubCategory',
      );
    if (body.blueLaw !== undefined)
      updates.blueLaw = this.optionalBoolean(body.blueLaw, 'blueLaw', false);
    if (body.linkedItems !== undefined)
      updates.linkedItems = this.optionalJson(body.linkedItems);
    if (body.kitchenPrint !== undefined)
      updates.kitchenPrint = this.optionalBoolean(
        body.kitchenPrint,
        'kitchenPrint',
        false,
      );
    if (body.allowEbt !== undefined)
      updates.allowEbt = this.optionalBoolean(body.allowEbt, 'allowEbt');
    if (body.trackInventory !== undefined)
      updates.trackInventory = this.optionalBoolean(
        body.trackInventory,
        'trackInventory',
        true,
      );
    if (body.allowNegativeInventory !== undefined)
      updates.allowNegativeInventory = this.optionalBoolean(
        body.allowNegativeInventory,
        'allowNegativeInventory',
        false,
      );
    if (body.taxStyle !== undefined)
      updates.taxStyle = this.requiredEnum(body.taxStyle, 'taxStyle', TaxStyle);
    if (body.isActive !== undefined)
      updates.isActive = this.requiredBoolean(body.isActive, 'isActive');

    return updates;
  }

  private parsePagination(query: Record<string, unknown>) {
    const page = this.optionalPositiveQueryInt(query.page, 'page') ?? 1;
    const take = this.optionalPositiveQueryInt(query.take, 'take') ?? 50;

    return {
      skip: (page - 1) * take,
      take: Math.min(take, 100),
    };
  }

  private parsePageLimit(query: Record<string, unknown>) {
    const page = this.optionalPositiveQueryInt(query.page, 'page') ?? 1;
    const limit = this.optionalPositiveQueryInt(query.limit, 'limit') ?? 100;
    const safeLimit = Math.min(limit, 100);

    return {
      page,
      limit: safeLimit,
      skip: (page - 1) * safeLimit,
    };
  }

  private parsePriceBookPagination(query: Record<string, unknown>) {
    const page = this.optionalPositiveQueryInt(query.page, 'page') ?? 1;
    const limit = this.optionalPositiveQueryInt(query.limit, 'limit') ?? 50;
    const safeLimit = Math.min(limit, 100);

    return {
      page,
      limit: safeLimit,
      skip: (page - 1) * safeLimit,
    };
  }

  private optionalMarginStatus(value: unknown): MarginStatus | undefined {
    if (value === undefined || value === null || value === '') {
      return undefined;
    }

    if (
      value === 'positive' ||
      value === 'zero' ||
      value === 'negative' ||
      value === 'unavailable'
    ) {
      return value;
    }

    throw new BadRequestException(
      'marginStatus must be one of positive, zero, negative, unavailable',
    );
  }

  private buildMarginWhere(
    marginStatus: MarginStatus | undefined,
  ): Prisma.ProductWhereInput {
    if (!marginStatus) return {};

    if (marginStatus === 'positive') return { margin: { gt: 0 } };
    if (marginStatus === 'zero') return { margin: 0 };
    if (marginStatus === 'negative') return { margin: { lt: 0 } };
    return { margin: null };
  }

  private priceBookOrderBy(
    sort: PriceBookSortField,
    order: 'asc' | 'desc',
  ): Prisma.ProductOrderByWithRelationInput[] {
    const secondary = { id: 'asc' as const };

    if (sort === 'department') {
      return [
        { department: { name: order } },
        { productNumber: 'asc' },
        secondary,
      ];
    }

    if (sort === 'category') {
      return [
        { productCategory: { name: order } },
        { productNumber: 'asc' },
        secondary,
      ];
    }

    if (sort === 'priceGroup') {
      return [
        { priceGroup: { name: order } },
        { productNumber: 'asc' },
        secondary,
      ];
    }

    if (sort === 'productNumber') {
      return [{ productNumber: order }, secondary];
    }

    return [{ [sort]: order }, { productNumber: 'asc' }, secondary];
  }

  private parseCreateDepartmentBody(body: Record<string, unknown>) {
    this.ensureAllowedFields(body, this.departmentFields);
    const minimumRingUpAmount = this.optionalCurrency(
      body.minimumRingUpAmount,
      'minimumRingUpAmount',
    );
    const maximumRingUpAmount = this.optionalCurrency(
      body.maximumRingUpAmount,
      'maximumRingUpAmount',
    );
    this.validateRingUpRange(minimumRingUpAmount, maximumRingUpAmount);
    const allowEbt =
      body.allowEbt !== undefined
        ? this.requiredBoolean(body.allowEbt, 'allowEbt')
        : (this.optionalBoolean(
            body.defaultAllowEbt,
            'defaultAllowEbt',
            false,
          ) ?? false);

    return {
      name: this.normalizeDepartmentName(body.name),
      posDepartmentNumber: this.requiredDepartmentNumber(
        body.posDepartmentNumber,
      ),
      type: this.requiredEnum(body.type, 'type', DepartmentType),
      defaultTaxId: this.requiredString(body.defaultTaxId, 'defaultTaxId'),
      minimumAge:
        this.optionalDepartmentMinimumAge(body.minimumAge) ??
        DepartmentMinimumAge.none,
      defaultRetailMargin: this.optionalPercentage(
        body.defaultRetailMargin,
        'defaultRetailMargin',
      ),
      minimumRingUpAmount,
      maximumRingUpAmount,
      trackInventory:
        this.optionalBoolean(body.trackInventory, 'trackInventory', true) ??
        true,
      allowNegativeInventorySales:
        this.optionalBoolean(
          body.allowNegativeInventorySales,
          'allowNegativeInventorySales',
          false,
        ) ?? false,
      allowEbt,
      allowManualRingUp:
        this.optionalBoolean(
          body.allowManualRingUp,
          'allowManualRingUp',
          false,
        ) ?? false,
      onPos: this.optionalBoolean(body.onPos, 'onPos', true) ?? true,
      isActive: this.optionalBoolean(body.isActive, 'isActive', true) ?? true,
    };
  }

  private parseUpdateDepartmentBody(body: Record<string, unknown>) {
    this.ensureAllowedFields(body, this.departmentFields);

    const data: DepartmentUpdateData = {};

    if (body.name !== undefined) {
      data.name = this.normalizeDepartmentName(body.name);
    }

    if (body.posDepartmentNumber !== undefined) {
      data.posDepartmentNumber = this.requiredDepartmentNumber(
        body.posDepartmentNumber,
      );
    }

    if (body.type !== undefined) {
      data.type = this.requiredEnum(body.type, 'type', DepartmentType);
    }

    if (body.defaultTaxId !== undefined) {
      data.defaultTaxId = this.requiredString(
        body.defaultTaxId,
        'defaultTaxId',
      );
    }

    if (body.minimumAge !== undefined) {
      data.minimumAge = this.requiredEnum(
        body.minimumAge,
        'minimumAge',
        DepartmentMinimumAge,
      );
    }

    if (body.defaultRetailMargin !== undefined) {
      data.defaultRetailMargin = this.optionalPercentage(
        body.defaultRetailMargin,
        'defaultRetailMargin',
      );
    }

    if (body.minimumRingUpAmount !== undefined) {
      data.minimumRingUpAmount = this.optionalCurrency(
        body.minimumRingUpAmount,
        'minimumRingUpAmount',
      );
    }

    if (body.maximumRingUpAmount !== undefined) {
      data.maximumRingUpAmount = this.optionalCurrency(
        body.maximumRingUpAmount,
        'maximumRingUpAmount',
      );
    }

    if (
      data.minimumRingUpAmount !== undefined ||
      data.maximumRingUpAmount !== undefined
    ) {
      this.validateRingUpRange(
        data.minimumRingUpAmount,
        data.maximumRingUpAmount,
      );
    }

    if (body.trackInventory !== undefined) {
      data.trackInventory = this.requiredBoolean(
        body.trackInventory,
        'trackInventory',
      );
    }

    if (body.allowNegativeInventorySales !== undefined) {
      data.allowNegativeInventorySales = this.requiredBoolean(
        body.allowNegativeInventorySales,
        'allowNegativeInventorySales',
      );
    }

    if (body.allowEbt !== undefined || body.defaultAllowEbt !== undefined) {
      data.allowEbt =
        body.allowEbt !== undefined
          ? this.requiredBoolean(body.allowEbt, 'allowEbt')
          : this.requiredBoolean(body.defaultAllowEbt, 'defaultAllowEbt');
    }

    if (body.allowManualRingUp !== undefined) {
      data.allowManualRingUp = this.requiredBoolean(
        body.allowManualRingUp,
        'allowManualRingUp',
      );
    }

    if (body.onPos !== undefined) {
      data.onPos = this.requiredBoolean(body.onPos, 'onPos');
    }

    if (body.isActive !== undefined) {
      data.isActive = this.requiredBoolean(body.isActive, 'isActive');
    }

    if (!Object.keys(data).length) {
      throw new BadRequestException(
        'At least one department field is required',
      );
    }

    return data;
  }

  private parseCreateCategoryBody(body: Record<string, unknown>) {
    this.ensureAllowedFields(body, this.categoryFields);

    return {
      name: this.normalizeCategoryName(body.name),
      departmentId: this.requiredString(body.departmentId, 'departmentId'),
      brand: this.optionalLimitedString(body.brand, 'brand', 100),
      description: this.optionalLimitedString(
        body.description,
        'description',
        240,
      ),
      isActive: this.optionalBoolean(body.isActive, 'isActive', true) ?? true,
    };
  }

  private parseUpdateCategoryBody(body: Record<string, unknown>) {
    this.ensureAllowedFields(body, this.categoryFields);
    const data: CategoryUpdateData = {};

    if (body.name !== undefined) {
      data.name = this.normalizeCategoryName(body.name);
    }

    if (body.departmentId !== undefined) {
      data.departmentId = this.requiredString(
        body.departmentId,
        'departmentId',
      );
    }

    if (body.brand !== undefined) {
      data.brand = this.optionalLimitedString(body.brand, 'brand', 100);
    }

    if (body.description !== undefined) {
      data.description = this.optionalLimitedString(
        body.description,
        'description',
        240,
      );
    }

    if (body.isActive !== undefined) {
      data.isActive = this.requiredBoolean(body.isActive, 'isActive');
    }

    if (!Object.keys(data).length) {
      throw new BadRequestException('At least one category field is required');
    }

    return data;
  }

  private normalizeCategoryName(value: unknown) {
    if (typeof value !== 'string') {
      throw new BadRequestException('name is required');
    }

    const normalized = value.trim().replace(/\s+/g, ' ');

    if (!normalized) {
      throw new BadRequestException('name is required');
    }

    if (normalized.length > 100) {
      throw new BadRequestException('name must be 100 characters or fewer');
    }

    if (
      [...normalized].some((character) => {
        const code = character.charCodeAt(0);
        return code < 32 || code === 127;
      })
    ) {
      throw new BadRequestException('name contains unsupported characters');
    }

    return normalized;
  }

  private optionalLimitedString(
    value: unknown,
    field: string,
    maxLength: number,
  ) {
    const parsed = this.optionalString(value, field);

    if (parsed !== null && parsed.length > maxLength) {
      throw new BadRequestException(
        `${field} must be ${maxLength} characters or fewer`,
      );
    }

    return parsed;
  }

  private parseCreatePriceGroupBody(body: Record<string, unknown>) {
    this.ensureAllowedFields(body, this.priceGroupFields);

    return {
      name: this.normalizePriceGroupName(body.name),
      description: this.optionalString(body.description, 'description'),
      defaultUnitRetail: this.requiredCurrency(
        body.defaultUnitRetail,
        'defaultUnitRetail',
      ),
      isActive: this.optionalBoolean(body.isActive, 'isActive', true) ?? true,
    };
  }

  private parseUpdatePriceGroupBody(body: Record<string, unknown>) {
    this.ensureAllowedFields(body, this.priceGroupFields);
    const data: PriceGroupUpdateData = {};

    if (body.name !== undefined) {
      data.name = this.normalizePriceGroupName(body.name);
    }

    if (body.description !== undefined) {
      data.description = this.optionalString(body.description, 'description');
    }

    if (body.defaultUnitRetail !== undefined) {
      data.defaultUnitRetail = this.requiredCurrency(
        body.defaultUnitRetail,
        'defaultUnitRetail',
      );
    }

    if (body.isActive !== undefined) {
      data.isActive = this.requiredBoolean(body.isActive, 'isActive');
    }

    if (!Object.keys(data).length) {
      throw new BadRequestException(
        'At least one price group field is required',
      );
    }

    return data;
  }

  private normalizePriceGroupName(value: unknown) {
    if (typeof value !== 'string') {
      throw new BadRequestException('name is required');
    }

    const normalized = value.trim().replace(/\s+/g, ' ');

    if (!normalized) {
      throw new BadRequestException('name is required');
    }

    if (normalized.length > 100) {
      throw new BadRequestException('name must be 100 characters or fewer');
    }

    if (
      [...normalized].some((character) => {
        const code = character.charCodeAt(0);
        return code < 32 || code === 127;
      })
    ) {
      throw new BadRequestException('name contains unsupported characters');
    }

    return normalized;
  }

  private parseCreateTaxBody(
    body: Record<string, unknown>,
    rateInput: TaxRateInput,
  ): TaxCreateData {
    this.ensureAllowedFields(body, this.taxFields);

    return {
      name: this.normalizeTaxName(body.name),
      rate: this.requiredTaxRate(body.rate, rateInput),
      surchargeAmount:
        this.optionalTaxSurcharge(body.surchargeAmount) ??
        new Prisma.Decimal(0),
      isActive: this.optionalBoolean(body.isActive, 'isActive', true) ?? true,
    };
  }

  private parseUpdateTaxBody(
    body: Record<string, unknown>,
    rateInput: TaxRateInput,
  ): TaxUpdateData {
    this.ensureAllowedFields(body, this.taxFields);
    const data: TaxUpdateData = {};

    if (body.name !== undefined) {
      data.name = this.normalizeTaxName(body.name);
    }

    if (body.rate !== undefined) {
      data.rate = this.requiredTaxRate(body.rate, rateInput);
    }

    if (body.surchargeAmount !== undefined) {
      data.surchargeAmount =
        this.optionalTaxSurcharge(body.surchargeAmount) ??
        new Prisma.Decimal(0);
    }

    if (body.isActive !== undefined) {
      data.isActive = this.requiredBoolean(body.isActive, 'isActive');
    }

    return data;
  }

  private normalizeTaxName(value: unknown) {
    if (typeof value !== 'string') {
      throw new BadRequestException('name is required');
    }

    const normalized = value.trim().replace(/\s+/g, ' ');

    if (!normalized) {
      throw new BadRequestException('name is required');
    }

    if (normalized.length > 100) {
      throw new BadRequestException('name must be 100 characters or fewer');
    }

    if (
      [...normalized].some((character) => {
        const code = character.charCodeAt(0);
        return code < 32 || code === 127;
      })
    ) {
      throw new BadRequestException('name contains unsupported characters');
    }

    return normalized;
  }

  private requiredTaxRate(value: unknown, rateInput: TaxRateInput) {
    const maxScale = rateInput === 'percent' ? 4 : 6;
    const parsed = this.requiredDecimal(value, 'rate', maxScale);
    const max = rateInput === 'percent' ? 100 : 1;

    if (parsed < 0 || parsed > max) {
      throw new BadRequestException(
        rateInput === 'percent'
          ? 'rate must be between 0 and 100'
          : 'rate must be between 0 and 1',
      );
    }

    const fraction = rateInput === 'percent' ? parsed / 100 : parsed;
    return Number(fraction.toFixed(6));
  }

  private optionalTaxSurcharge(value: unknown) {
    if (value === undefined || value === null || value === '') {
      return null;
    }

    const parsed = this.requiredDecimal(value, 'surchargeAmount', 2);

    if (parsed < 0) {
      throw new BadRequestException('surchargeAmount must be zero or greater');
    }

    if (parsed > 9999999999.99) {
      throw new BadRequestException('surchargeAmount is too large');
    }

    return new Prisma.Decimal(parsed);
  }

  private async ensureTaxNameAvailable(
    storeId: string,
    name: string,
    ignoreId?: string,
  ) {
    const normalized = name.toLocaleLowerCase();
    const taxes = await this.prisma.tax.findMany({
      where: {
        storeId,
        ...(ignoreId ? { id: { not: ignoreId } } : {}),
      },
      select: { name: true },
    });
    const duplicate = taxes.some(
      (tax) =>
        tax.name.trim().replace(/\s+/g, ' ').toLocaleLowerCase() === normalized,
    );

    if (duplicate) {
      throw new ConflictException(
        'A tax with this name already exists in this store.',
      );
    }
  }

  private requiredCurrency(value: unknown, field: string) {
    const parsed = this.requiredDecimal(value, field, 2);

    if (parsed < 0) {
      throw new BadRequestException(`${field} must be zero or greater`);
    }

    if (parsed > 9999999999.99) {
      throw new BadRequestException(`${field} is too large`);
    }

    return new Prisma.Decimal(parsed);
  }

  private async ensurePriceGroupNameAvailable(
    storeId: string,
    name: string,
    ignoreId?: string,
  ) {
    const normalized = name.toLocaleLowerCase();
    const priceGroups = await this.prisma.priceGroup.findMany({
      where: {
        storeId,
        ...(ignoreId ? { NOT: { id: ignoreId } } : {}),
      },
      select: { name: true },
    });
    const duplicate = priceGroups.some(
      (priceGroup) =>
        priceGroup.name.trim().replace(/\s+/g, ' ').toLocaleLowerCase() ===
        normalized,
    );

    if (duplicate) {
      throw new ConflictException(
        'A price group with this name already exists in this store.',
      );
    }
  }

  async recountPriceGroupMismatchCache(priceGroupId: string) {
    const priceGroup = await this.prisma.priceGroup.findUnique({
      where: { id: priceGroupId },
      select: { id: true, defaultUnitRetail: true },
    });

    if (!priceGroup) {
      return null;
    }

    const defaultCents = this.toCents(priceGroup.defaultUnitRetail);
    const products = await this.prisma.product.findMany({
      where: { priceGroupId },
      select: { unitRetail: true },
    });
    const mismatchedItemCount = products.filter(
      (product) => this.toCents(product.unitRetail) !== defaultCents,
    ).length;

    return this.prisma.priceGroup.update({
      where: { id: priceGroupId },
      data: {
        mismatchedItemCount,
        mismatchCountUpdatedAt: new Date(),
      },
    });
  }

  async refreshAllPriceGroupMismatchCaches() {
    const priceGroups = await this.prisma.priceGroup.findMany({
      where: { isActive: true },
      select: { id: true },
    });

    for (const priceGroup of priceGroups) {
      try {
        await this.recountPriceGroupMismatchCache(priceGroup.id);
      } catch (error) {
        this.logger.warn(
          `Price group mismatch recount failed for ${priceGroup.id}: ${
            error instanceof Error ? error.message : 'unknown error'
          }`,
        );
      }
    }
  }

  private async safeRecountPriceGroups(ids: Array<string | null | undefined>) {
    const uniqueIds = [...new Set(ids.filter(Boolean))] as string[];

    for (const id of uniqueIds) {
      try {
        await this.recountPriceGroupMismatchCache(id);
      } catch (error) {
        this.logger.warn(
          `Price group mismatch recount failed for ${id}: ${
            error instanceof Error ? error.message : 'unknown error'
          }`,
        );
      }
    }
  }

  private toCents(value: number | Prisma.Decimal) {
    return Math.round(Number(value) * 100);
  }

  private ensureAllowedFields(
    body: Record<string, unknown>,
    allowedFields: string[],
  ) {
    const allowed = new Set(allowedFields);
    const unknown = Object.keys(body).find((key) => !allowed.has(key));

    if (unknown) {
      throw new BadRequestException(`${unknown} is not allowed`);
    }
  }

  private normalizeDepartmentName(value: unknown) {
    if (typeof value !== 'string') {
      throw new BadRequestException('name is required');
    }

    const normalized = value.trim().replace(/\s+/g, ' ');

    if (normalized.length < 2) {
      throw new BadRequestException(
        'Department name must be at least 2 characters',
      );
    }

    if (normalized.length > 100) {
      throw new BadRequestException(
        'Department name must be 100 characters or fewer',
      );
    }

    if (
      [...normalized].some((character) => {
        const code = character.charCodeAt(0);
        return code < 32 || code === 127;
      })
    ) {
      throw new BadRequestException(
        'Department name contains unsupported characters',
      );
    }

    if (!/^[-A-Za-z0-9 '&/() ]+$/.test(normalized)) {
      throw new BadRequestException(
        'Department name contains unsupported characters',
      );
    }

    return normalized;
  }

  private requiredDepartmentNumber(value: unknown) {
    const number = this.requiredPositiveInt(value, 'posDepartmentNumber');

    if (number > 9999) {
      throw new BadRequestException(
        'posDepartmentNumber must be 9999 or lower',
      );
    }

    return number;
  }

  private optionalDepartmentMinimumAge(value: unknown) {
    if (value === undefined || value === null || value === '') {
      return undefined;
    }

    return this.requiredEnum(value, 'minimumAge', DepartmentMinimumAge);
  }

  private optionalPercentage(value: unknown, field: string) {
    if (value === undefined || value === null || value === '') {
      return null;
    }

    const parsed = this.requiredDecimal(value, field, 4);

    if (parsed < 0 || parsed > 100) {
      throw new BadRequestException(`${field} must be between 0 and 100`);
    }

    return new Prisma.Decimal(parsed);
  }

  private optionalCurrency(value: unknown, field: string) {
    if (value === undefined || value === null || value === '') {
      return null;
    }

    const parsed = this.requiredDecimal(value, field, 2);

    if (parsed < 0) {
      throw new BadRequestException(`${field} must be zero or greater`);
    }

    return new Prisma.Decimal(parsed);
  }

  private requiredDecimal(value: unknown, field: string, maxScale: number) {
    if (typeof value !== 'number' && typeof value !== 'string') {
      throw new BadRequestException(`${field} must be a number`);
    }

    const raw = String(value).trim();

    if (!/^\d+(\.\d+)?$/.test(raw)) {
      throw new BadRequestException(`${field} must be a valid number`);
    }

    const decimalPart = raw.split('.')[1] ?? '';

    if (decimalPart.length > maxScale) {
      throw new BadRequestException(
        `${field} must have ${maxScale} or fewer decimal places`,
      );
    }

    const parsed = Number(raw);

    if (!Number.isFinite(parsed)) {
      throw new BadRequestException(`${field} must be a finite number`);
    }

    return parsed;
  }

  private validateRingUpRange(
    minimum: Prisma.Decimal | null | undefined,
    maximum: Prisma.Decimal | null | undefined,
  ) {
    if (minimum && maximum && minimum.greaterThan(maximum)) {
      throw new BadRequestException(
        'minimumRingUpAmount cannot exceed maximumRingUpAmount',
      );
    }
  }

  private isPositiveIntegerText(value: string) {
    return /^[1-9]\d*$/.test(value);
  }

  private async ensureDepartmentNameAvailable(
    storeId: string,
    name: string,
    currentDepartmentId?: string,
  ) {
    const existing = await this.prisma.department.findFirst({
      where: {
        storeId,
        name: { equals: name, mode: 'insensitive' },
        ...(currentDepartmentId ? { id: { not: currentDepartmentId } } : {}),
      },
      select: { id: true },
    });

    if (existing) {
      throw new ConflictException(
        'A department with this name already exists in this store.',
      );
    }
  }

  private async ensureDepartmentNumberAvailable(
    storeId: string,
    posDepartmentNumber: number,
    currentDepartmentId?: string,
  ) {
    const existing = await this.prisma.department.findFirst({
      where: {
        storeId,
        posDepartmentNumber,
        ...(currentDepartmentId ? { id: { not: currentDepartmentId } } : {}),
      },
      select: { id: true },
    });

    if (existing) {
      throw new ConflictException(
        'A department with this POS department number already exists in this store.',
      );
    }
  }

  private async ensureActiveTaxInStore(storeId: string, taxId: string) {
    const tax = await this.prisma.tax.findFirst({
      where: { id: taxId, storeId, isActive: true },
      select: { id: true },
    });

    if (!tax) {
      throw new BadRequestException(
        'defaultTaxId must belong to an active tax for this store',
      );
    }
  }

  private async ensureActiveDepartmentInStore(
    storeId: string,
    departmentId: string,
  ) {
    const department = await this.prisma.department.findFirst({
      where: { id: departmentId, storeId, isActive: true },
      select: { id: true },
    });

    if (!department) {
      throw new BadRequestException(
        'departmentId must belong to an active department for this store',
      );
    }
  }

  private async ensureCategoryNameAvailable(
    storeId: string,
    departmentId: string,
    name: string,
    currentCategoryId?: string,
  ) {
    const normalized = name.toLocaleLowerCase();
    const categories = await this.prisma.productCategory.findMany({
      where: {
        storeId,
        departmentId,
        ...(currentCategoryId ? { id: { not: currentCategoryId } } : {}),
      },
      select: { name: true },
    });
    const duplicate = categories.some(
      (category) =>
        category.name.trim().replace(/\s+/g, ' ').toLocaleLowerCase() ===
        normalized,
    );

    if (duplicate) {
      throw new ConflictException(
        'A category with this name already exists in this department.',
      );
    }
  }

  private optionalQueryBoolean(value: unknown, field: string) {
    if (value === undefined || value === null || value === '') {
      return undefined;
    }

    if (value === 'true' || value === true) {
      return true;
    }

    if (value === 'false' || value === false) {
      return false;
    }

    throw new BadRequestException(`${field} must be true or false`);
  }

  private optionalSearch(value: unknown, field: string) {
    if (value === undefined || value === null || value === '') {
      return undefined;
    }

    if (typeof value !== 'string') {
      throw new BadRequestException(`${field} must be a string`);
    }

    const normalized = value.trim().replace(/\s+/g, ' ');

    if (normalized.length > 100) {
      throw new BadRequestException(`${field} must be 100 characters or fewer`);
    }

    return normalized || undefined;
  }

  private optionalSort<T extends string>(
    value: unknown,
    allowedValues: readonly T[],
    fallback: T,
    field: string,
  ) {
    if (value === undefined || value === null || value === '') {
      return fallback;
    }

    if (typeof value !== 'string' || !allowedValues.includes(value as T)) {
      throw new BadRequestException(
        `${field} must be one of ${allowedValues.join(', ')}`,
      );
    }

    return value as T;
  }

  private isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }

  private requiredString(value: unknown, field: string) {
    if (typeof value !== 'string' || !value.trim()) {
      throw new BadRequestException(`${field} is required`);
    }

    return value.trim();
  }

  private validateBarcode(value: unknown) {
    const barcode = this.requiredString(value, 'barcode').replace(
      /[\r\n\t]+$/g,
      '',
    );

    if (barcode.length > 64) {
      throw new BadRequestException('barcode must be 64 characters or fewer');
    }

    if (/\s/.test(barcode)) {
      throw new BadRequestException('barcode cannot contain spaces');
    }

    if (!/^[\x21-\x7e]+$/.test(barcode)) {
      throw new BadRequestException('barcode contains unsupported characters');
    }

    if (/^\d+$/.test(barcode) && [8, 12, 13].includes(barcode.length)) {
      const digits = [...barcode].map((digit) => Number(digit));
      const checkDigit = digits.at(-1);
      const body = digits.slice(0, -1);
      const sum = body
        .slice()
        .reverse()
        .reduce(
          (total, digit, index) => total + digit * (index % 2 === 0 ? 3 : 1),
          0,
        );
      const expected = (10 - (sum % 10)) % 10;

      if (checkDigit !== expected) {
        throw new BadRequestException(
          'barcode has an invalid UPC/EAN check digit',
        );
      }
    }

    return barcode;
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

  private requiredNumber(value: unknown, field: string) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new BadRequestException(`${field} must be a number`);
    }

    if (value < 0) {
      throw new BadRequestException(`${field} must be zero or greater`);
    }

    return value;
  }

  private optionalNumber(value: unknown, field: string, fallback?: number) {
    if (value === undefined || value === null) {
      return fallback ?? null;
    }

    return this.requiredNumber(value, field);
  }

  private optionalInt(value: unknown, field: string) {
    if (value === undefined || value === null) {
      return null;
    }

    return this.requiredInt(value, field);
  }

  private requiredInt(value: unknown, field: string) {
    if (typeof value !== 'number' || !Number.isInteger(value)) {
      throw new BadRequestException(`${field} must be an integer`);
    }

    if (value < 0) {
      throw new BadRequestException(`${field} must be zero or greater`);
    }

    return value;
  }

  private requiredSignedInt(value: unknown, field: string) {
    if (typeof value !== 'number' || !Number.isInteger(value)) {
      throw new BadRequestException(`${field} must be an integer`);
    }

    return value;
  }

  private requiredNonZeroInt(value: unknown, field: string) {
    const parsed = this.requiredSignedInt(value, field);

    if (parsed === 0) {
      throw new BadRequestException(`${field} cannot be zero`);
    }

    return parsed;
  }

  private requiredPositiveInt(value: unknown, field: string) {
    const parsed = this.requiredInt(value, field);

    if (parsed <= 0) {
      throw new BadRequestException(`${field} must be greater than zero`);
    }

    return parsed;
  }

  private optionalPositiveInt(value: unknown, field: string) {
    const parsed = this.optionalInt(value, field);

    if (parsed !== null && parsed <= 0) {
      throw new BadRequestException(`${field} must be greater than zero`);
    }

    return parsed;
  }

  private optionalPositiveQueryInt(value: unknown, field: string) {
    if (value === undefined || value === null || value === '') {
      return undefined;
    }

    const parsed =
      typeof value === 'number'
        ? value
        : typeof value === 'string'
          ? Number(value)
          : NaN;

    if (!Number.isInteger(parsed) || parsed <= 0) {
      throw new BadRequestException(`${field} must be a positive integer`);
    }

    return parsed;
  }

  private optionalBoolean(value: unknown, field: string, fallback?: boolean) {
    if (value === undefined || value === null) {
      return fallback ?? undefined;
    }

    return this.requiredBoolean(value, field);
  }

  private requiredBoolean(value: unknown, field: string) {
    if (typeof value !== 'boolean') {
      throw new BadRequestException(`${field} must be a boolean`);
    }

    return value;
  }

  private requiredEnum<T extends Record<string, string>>(
    value: unknown,
    field: string,
    enumObject: T,
  ): T[keyof T] {
    if (
      typeof value !== 'string' ||
      !Object.values(enumObject).includes(value)
    ) {
      throw new BadRequestException(
        `${field} must be one of ${Object.values(enumObject).join(', ')}`,
      );
    }

    return value as T[keyof T];
  }

  private optionalJson(value: unknown) {
    if (value === undefined) {
      return undefined;
    }

    if (value === null) {
      return Prisma.JsonNull;
    }

    return value as Prisma.InputJsonValue;
  }

  private handleBarcodeConflict(error: unknown) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002'
    ) {
      throw new ConflictException(
        'An item with this barcode already exists in this store.',
      );
    }
  }

  private handleSetupNameConflict(error: unknown, label: string) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002'
    ) {
      throw new ConflictException(
        `A ${label} with that name already exists for this store`,
      );
    }
  }

  private handleDepartmentNameConflict(error: unknown) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002'
    ) {
      throw new ConflictException(
        'A department with this name already exists in this store.',
      );
    }
  }

  private handleDepartmentConflict(error: unknown) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002'
    ) {
      const target = Array.isArray(error.meta?.target)
        ? error.meta.target.join(',')
        : typeof error.meta?.target === 'string' ||
            typeof error.meta?.target === 'number'
          ? String(error.meta.target)
          : '';

      if (target.includes('posDepartmentNumber')) {
        throw new ConflictException(
          'A department with this POS department number already exists in this store.',
        );
      }

      throw new ConflictException(
        'A department with this name already exists in this store.',
      );
    }
  }

  private serializeDepartment(
    department: Prisma.DepartmentGetPayload<{
      include: { _count: { select: { products: true } }; defaultTax: true };
    }>,
  ) {
    return {
      id: department.id,
      storeId: department.storeId,
      name: department.name,
      posDepartmentNumber: department.posDepartmentNumber,
      type: department.type,
      defaultTaxId: department.defaultTaxId,
      defaultTax: department.defaultTax
        ? {
            id: department.defaultTax.id,
            storeId: department.defaultTax.storeId,
            name: department.defaultTax.name,
            rate: department.defaultTax.rate,
            surchargeAmount: department.defaultTax.surchargeAmount.toFixed(2),
            isActive: department.defaultTax.isActive,
          }
        : null,
      minimumAge: department.minimumAge,
      defaultRetailMargin:
        department.defaultRetailMargin === null
          ? null
          : Number(department.defaultRetailMargin),
      minimumRingUpAmount:
        department.minimumRingUpAmount === null
          ? null
          : Number(department.minimumRingUpAmount),
      maximumRingUpAmount:
        department.maximumRingUpAmount === null
          ? null
          : Number(department.maximumRingUpAmount),
      trackInventory: department.trackInventory,
      allowNegativeInventorySales: department.allowNegativeInventorySales,
      allowEbt: department.allowEbt,
      defaultAllowEbt: department.allowEbt,
      allowManualRingUp: department.allowManualRingUp,
      onPos: department.onPos,
      isActive: department.isActive,
      createdAt: department.createdAt,
      updatedAt: department.updatedAt,
      productCount: department._count.products,
    };
  }

  private serializeTaxReference(tax: TaxRecord) {
    return {
      id: tax.id,
      storeId: tax.storeId,
      name: tax.name,
      rate: tax.rate,
      surchargeAmount: tax.surchargeAmount.toFixed(2),
      isActive: tax.isActive,
    };
  }

  private serializeTax(tax: TaxRecord & { _count?: { departments: number } }) {
    return {
      id: tax.id,
      storeId: tax.storeId,
      name: tax.name,
      rate: this.percentString(tax.rate),
      surchargeAmount: tax.surchargeAmount.toFixed(2),
      isActive: tax.isActive,
      departmentCount: tax._count?.departments ?? 0,
      createdAt: tax.createdAt,
      updatedAt: tax.updatedAt,
    };
  }

  private percentString(rate: number) {
    return new Prisma.Decimal(rate)
      .mul(100)
      .toFixed(4)
      .replace(/0+$/, '')
      .replace(/\.$/, '');
  }

  private serializePriceGroup(
    priceGroup: Prisma.PriceGroupGetPayload<{
      include: { _count: { select: { products: true } } };
    }>,
  ) {
    return {
      id: priceGroup.id,
      storeId: priceGroup.storeId,
      name: priceGroup.name,
      description: priceGroup.description,
      defaultUnitRetail: priceGroup.defaultUnitRetail.toFixed(2),
      mismatchedItemCount: priceGroup.mismatchedItemCount,
      mismatchCountUpdatedAt: priceGroup.mismatchCountUpdatedAt,
      isActive: priceGroup.isActive,
      createdAt: priceGroup.createdAt,
      updatedAt: priceGroup.updatedAt,
      productCount: priceGroup._count.products,
    };
  }

  private serializeProductCategory(
    category: Prisma.ProductCategoryGetPayload<{
      include: { department: true; _count: { select: { products: true } } };
    }>,
  ) {
    return {
      id: category.id,
      storeId: category.storeId,
      name: category.name,
      brand: category.brand,
      description: category.description,
      departmentId: category.departmentId,
      departmentName: category.department?.name ?? null,
      posDepartmentNumber: category.department?.posDepartmentNumber ?? null,
      isActive: category.isActive,
      createdAt: category.createdAt,
      updatedAt: category.updatedAt,
      productCount: category._count.products,
    };
  }

  private serializePriceBookProduct(product: PriceBookProductRecord) {
    return {
      id: product.id,
      productNumber: product.productNumber,
      barcode: product.barcode,
      name: product.name,
      saleType: product.saleType,
      unitRetail: product.unitRetail.toFixed(2),
      onlineRetailPrice:
        product.onlineRetailPrice === null
          ? null
          : product.onlineRetailPrice.toFixed(2),
      unitCost: product.unitCost === null ? null : product.unitCost.toFixed(2),
      unitCostAfterDiscountAndRebate:
        product.unitCostAfterDiscountAndRebate === null
          ? null
          : product.unitCostAfterDiscountAndRebate.toFixed(2),
      margin: product.margin === null ? null : product.margin.toFixed(2),
      defaultMargin:
        product.defaultMargin === null
          ? null
          : product.defaultMargin.toFixed(2),
      unitsPerCase: product.unitsPerCase,
      caseCost: product.caseCost === null ? null : product.caseCost.toFixed(2),
      caseDiscount: product.caseDiscount.toFixed(2),
      caseRebate: product.caseRebate.toFixed(2),
      currentQuantity: product.currentQuantity,
      minInventory: product.minInventory,
      maxInventory: product.maxInventory,
      trackInventory: product.trackInventory,
      allowNegativeInventory: product.allowNegativeInventory,
      unitOfMeasure: product.unitOfMeasure,
      size: product.size,
      minimumAge: product.minimumAge,
      allowEbt: product.allowEbt,
      isActive: product.isActive,
      updatedAt: product.updatedAt,
      department: {
        id: product.department.id,
        name: product.department.name,
      },
      category: product.productCategory
        ? {
            id: product.productCategory.id,
            name: product.productCategory.name,
          }
        : null,
      priceGroup: product.priceGroup
        ? {
            id: product.priceGroup.id,
            name: product.priceGroup.name,
          }
        : null,
      tax: {
        id: product.tax.id,
        name: product.tax.name,
        rate: this.percentString(product.tax.rate),
        surchargeAmount: product.tax.surchargeAmount.toFixed(2),
      },
    };
  }

  private readonly departmentFields = [
    'name',
    'posDepartmentNumber',
    'type',
    'defaultTaxId',
    'minimumAge',
    'defaultRetailMargin',
    'minimumRingUpAmount',
    'maximumRingUpAmount',
    'trackInventory',
    'allowNegativeInventorySales',
    'allowEbt',
    'defaultAllowEbt',
    'allowManualRingUp',
    'onPos',
    'isActive',
  ];

  private readonly categoryFields = [
    'name',
    'departmentId',
    'brand',
    'description',
    'isActive',
  ];

  private readonly priceGroupFields = [
    'name',
    'description',
    'defaultUnitRetail',
    'isActive',
  ];

  private readonly taxFields = ['name', 'rate', 'surchargeAmount', 'isActive'];

  private readonly productInclude = {
    department: true,
    priceGroup: true,
    productCategory: { include: { department: true } },
    tax: true,
    store: true,
  } satisfies Prisma.ProductInclude;

  private readonly priceBookProductSelect = {
    id: true,
    productNumber: true,
    barcode: true,
    name: true,
    saleType: true,
    unitRetail: true,
    onlineRetailPrice: true,
    unitCost: true,
    unitCostAfterDiscountAndRebate: true,
    margin: true,
    defaultMargin: true,
    unitsPerCase: true,
    caseCost: true,
    caseDiscount: true,
    caseRebate: true,
    currentQuantity: true,
    minInventory: true,
    maxInventory: true,
    trackInventory: true,
    allowNegativeInventory: true,
    unitOfMeasure: true,
    size: true,
    minimumAge: true,
    allowEbt: true,
    isActive: true,
    updatedAt: true,
    department: { select: { id: true, name: true } },
    productCategory: { select: { id: true, name: true } },
    priceGroup: { select: { id: true, name: true } },
    tax: {
      select: { id: true, name: true, rate: true, surchargeAmount: true },
    },
  } satisfies Prisma.ProductSelect;

  private readonly inventoryOverviewProductSelect = {
    id: true,
    productNumber: true,
    barcode: true,
    name: true,
    currentQuantity: true,
    unitsPerCase: true,
    caseCost: true,
    unitCost: true,
    unitCostAfterDiscountAndRebate: true,
    unitRetail: true,
    minInventory: true,
    trackInventory: true,
    isActive: true,
    createdAt: true,
    department: { select: { id: true, name: true } },
  } satisfies Prisma.ProductSelect;

  private readonly inventoryLogInclude = {
    product: true,
    staff: true,
    store: true,
  } satisfies Prisma.InventoryLogInclude;
}

type ProductCreateDto = ProductCalculationInput & {
  storeId: string;
  barcode: string;
  name: string;
  departmentId: string;
  priceGroupId: string | null;
  productCategoryId: string | null;
  saleType: ProductSaleType;
  currentQuantity: number;
  onlineRetailPrice: number | null;
  unitOfMeasure: string | null;
  size: string | null;
  defaultMargin: number | null;
  maxInventory: number | null;
  minInventory: number | null;
  minimumAge: number | null;
  taxId: string;
  nacsCode: string | null;
  nacsCategory: string | null;
  nacsSubCategory: string | null;
  blueLaw: boolean;
  linkedItems?: Prisma.InputJsonValue | Prisma.NullTypes.JsonNull;
  kitchenPrint: boolean;
  allowEbt?: boolean;
  trackInventory: boolean;
  allowNegativeInventory: boolean;
  taxStyle: TaxStyle;
  isActive: boolean;
};

type ProductUpdateDto = Partial<Omit<ProductCreateDto, 'storeId'>>;

type PriceBookProductRecord = Prisma.ProductGetPayload<{
  select: ProductService['priceBookProductSelect'];
}>;

type InventoryOverviewProductRecord = Prisma.ProductGetPayload<{
  select: ProductService['inventoryOverviewProductSelect'];
}>;

type DepartmentUpdateData = {
  name?: string;
  posDepartmentNumber?: number;
  type?: DepartmentType;
  defaultTaxId?: string;
  minimumAge?: DepartmentMinimumAge;
  defaultRetailMargin?: Prisma.Decimal | null;
  minimumRingUpAmount?: Prisma.Decimal | null;
  maximumRingUpAmount?: Prisma.Decimal | null;
  trackInventory?: boolean;
  allowNegativeInventorySales?: boolean;
  allowEbt?: boolean;
  allowManualRingUp?: boolean;
  onPos?: boolean;
  isActive?: boolean;
};

type CategoryUpdateData = {
  name?: string;
  departmentId?: string;
  brand?: string | null;
  description?: string | null;
  isActive?: boolean;
};

type PriceGroupUpdateData = {
  name?: string;
  description?: string | null;
  defaultUnitRetail?: Prisma.Decimal;
  isActive?: boolean;
};

type TaxRateInput = 'percent' | 'fraction';

type TaxOperationOptions = {
  rateInput?: TaxRateInput;
  response?: 'store' | 'legacy';
};

type TaxCreateData = {
  name: string;
  rate: number;
  surchargeAmount: Prisma.Decimal;
  isActive: boolean;
};

type TaxUpdateData = Partial<TaxCreateData>;

type TaxRecord = Prisma.TaxGetPayload<Record<string, never>>;

type InventoryReceiveDto = {
  storeId: string;
  items: {
    productId: string;
    quantity: number;
    caseCost?: number | null;
    referenceId?: string | null;
    notes?: string | null;
  }[];
};

type InventoryAdjustmentDto = {
  storeId: string;
  productId: string;
  adjustment: number;
  reason: string;
  notes?: string | null;
};

type ProductCalculationInput = {
  unitsPerCase?: number | null;
  caseCost?: number | null;
  caseDiscount: number;
  caseRebate: number;
  unitRetail: number;
};
