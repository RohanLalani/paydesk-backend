import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  DepartmentMinimumAge,
  DepartmentType,
  InventoryActionType,
  Prisma,
  ProductSaleType,
  TaxStyle,
} from '@prisma/client';
import { AuthTokenPayload } from '../auth/strategies/jwt.strategy';
import { PosAccessService } from '../common/pos-access.service';
import { PrismaService } from '../prisma.service';

@Injectable()
export class ProductService {
  private readonly logger = new Logger(ProductService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly access: PosAccessService,
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
      const department = await this.prisma.department.create({
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
      const updated = await this.prisma.department.update({
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

    return this.prisma.department.update({
      where: { id },
      data: { isActive: false },
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
      const priceGroup = await this.prisma.priceGroup.create({
        data: {
          ...dto,
          storeId,
          mismatchCountUpdatedAt: new Date(),
        },
        include: { _count: { select: { products: true } } },
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
      const updated = await this.prisma.priceGroup.update({
        where: { id: priceGroupId },
        data,
        include: { _count: { select: { products: true } } },
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

    return this.prisma.priceGroup.update({
      where: { id },
      data: { isActive: false },
    });
  }

  async createProductCategory(
    body: Record<string, unknown>,
    user: AuthTokenPayload,
  ) {
    const dto = {
      storeId: this.requiredString(body.storeId, 'storeId'),
      name: this.requiredString(body.name, 'name'),
      brand: this.optionalString(body.brand, 'brand'),
      description: this.optionalString(body.description, 'description'),
    };
    await this.access.ensureStoreAccess(dto.storeId, user, 'manage_products');

    try {
      return await this.prisma.productCategory.create({ data: dto });
    } catch (error) {
      this.handleSetupNameConflict(error, 'product category');
      throw error;
    }
  }

  async listProductCategories(storeId: string, user: AuthTokenPayload) {
    await this.access.ensureStoreAccess(storeId, user, 'manage_products');

    return this.prisma.productCategory.findMany({
      where: { storeId, isActive: true },
      orderBy: { name: 'asc' },
    });
  }

  async updateProductCategory(
    id: string,
    body: Record<string, unknown>,
    user: AuthTokenPayload,
  ) {
    const productCategory = await this.findProductCategoryOrThrow(id);
    await this.access.ensureStoreAccess(
      productCategory.storeId,
      user,
      'manage_products',
    );
    const data: Prisma.ProductCategoryUpdateInput = {};

    if (body.name !== undefined) {
      data.name = this.requiredString(body.name, 'name');
    }

    if (body.brand !== undefined) {
      data.brand = this.optionalString(body.brand, 'brand');
    }

    if (body.description !== undefined) {
      data.description = this.optionalString(body.description, 'description');
    }

    try {
      return await this.prisma.productCategory.update({ where: { id }, data });
    } catch (error) {
      this.handleSetupNameConflict(error, 'product category');
      throw error;
    }
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

    return this.prisma.productCategory.update({
      where: { id },
      data: { isActive: false },
    });
  }

  async createTax(body: Record<string, unknown>, user: AuthTokenPayload) {
    const dto = {
      storeId: this.requiredString(body.storeId, 'storeId'),
      name: this.requiredString(body.name, 'name'),
      rate: this.requiredNumber(body.rate, 'rate'),
    };
    await this.access.ensureStoreAccess(dto.storeId, user, 'manage_products');

    try {
      return await this.prisma.tax.create({ data: dto });
    } catch (error) {
      this.handleSetupNameConflict(error, 'tax');
      throw error;
    }
  }

  async listTaxes(storeId: string, user: AuthTokenPayload) {
    await this.access.ensureStoreAccess(storeId, user, 'manage_products');

    return this.prisma.tax.findMany({
      where: { storeId, isActive: true },
      orderBy: { name: 'asc' },
    });
  }

  async updateTax(
    id: string,
    body: Record<string, unknown>,
    user: AuthTokenPayload,
  ) {
    const tax = await this.findTaxOrThrow(id);
    await this.access.ensureStoreAccess(tax.storeId, user, 'manage_products');
    const data: Prisma.TaxUpdateInput = {};

    if (body.name !== undefined) {
      data.name = this.requiredString(body.name, 'name');
    }

    if (body.rate !== undefined) {
      data.rate = this.requiredNumber(body.rate, 'rate');
    }

    try {
      return await this.prisma.tax.update({ where: { id }, data });
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

    return this.prisma.tax.update({
      where: { id },
      data: { isActive: false },
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
      const product = await this.prisma.$transaction(async (tx) => {
        const product = await tx.product.create({
          data: {
            ...dto,
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
      const updated = await this.prisma.$transaction(async (tx) => {
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

  async remove(productId: string, user: AuthTokenPayload) {
    const product = await this.findActiveProductOrThrow(productId);
    await this.access.ensureStoreAccess(
      product.storeId,
      user,
      'manage_products',
    );

    const removed = await this.prisma.product.update({
      where: { id: productId },
      data: { isActive: false },
      include: this.productInclude,
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

    return this.prisma.$transaction(async (tx) => {
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

        updatedProducts.push(updated);
      }

      return updatedProducts;
    });
  }

  async adjustInventory(body: Record<string, unknown>, user: AuthTokenPayload) {
    const dto = this.parseAdjustInventoryBody(body);
    await this.access.ensureStoreAccess(dto.storeId, user, 'manage_inventory');

    return this.prisma.$transaction(async (tx) => {
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

  private readonly priceGroupFields = [
    'name',
    'description',
    'defaultUnitRetail',
    'isActive',
  ];

  private readonly productInclude = {
    department: true,
    priceGroup: true,
    productCategory: true,
    tax: true,
    store: true,
  } satisfies Prisma.ProductInclude;

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

type PriceGroupUpdateData = {
  name?: string;
  description?: string | null;
  defaultUnitRetail?: Prisma.Decimal;
  isActive?: boolean;
};

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
