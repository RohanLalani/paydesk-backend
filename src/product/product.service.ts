import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, ProductSaleType, TaxStyle } from '@prisma/client';
import { AuthTokenPayload } from '../auth/strategies/jwt.strategy';
import { PosAccessService } from '../common/pos-access.service';
import { PrismaService } from '../prisma.service';

@Injectable()
export class ProductService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: PosAccessService,
  ) {}

  async createDepartment(body: Record<string, unknown>, user: AuthTokenPayload) {
    const dto = {
      storeId: this.requiredString(body.storeId, 'storeId'),
      name: this.requiredString(body.name, 'name'),
      defaultAllowEbt:
        this.optionalBoolean(body.defaultAllowEbt, 'defaultAllowEbt', false) ??
        false,
    };
    await this.access.ensureStoreAccess(
      dto.storeId,
      user,
      'manage_departments',
    );

    try {
      return await this.prisma.department.create({ data: dto });
    } catch (error) {
      this.handleSetupNameConflict(error, 'department');
      throw error;
    }
  }

  async listDepartments(storeId: string, user: AuthTokenPayload) {
    await this.access.ensureStoreAccess(storeId, user, 'manage_departments');

    return this.prisma.department.findMany({
      where: { storeId, isActive: true },
      orderBy: { name: 'asc' },
    });
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
      'manage_departments',
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
      'manage_departments',
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

  async createPriceGroup(body: Record<string, unknown>, user: AuthTokenPayload) {
    const dto = {
      storeId: this.requiredString(body.storeId, 'storeId'),
      name: this.requiredString(body.name, 'name'),
      description: this.optionalString(body.description, 'description'),
    };
    await this.access.ensureStoreAccess(
      dto.storeId,
      user,
      'manage_price_groups',
    );

    try {
      return await this.prisma.priceGroup.create({ data: dto });
    } catch (error) {
      this.handleSetupNameConflict(error, 'price group');
      throw error;
    }
  }

  async listPriceGroups(storeId: string, user: AuthTokenPayload) {
    await this.access.ensureStoreAccess(storeId, user, 'manage_price_groups');

    return this.prisma.priceGroup.findMany({
      where: { storeId, isActive: true },
      orderBy: { name: 'asc' },
    });
  }

  async updatePriceGroup(
    id: string,
    body: Record<string, unknown>,
    user: AuthTokenPayload,
  ) {
    const priceGroup = await this.findPriceGroupOrThrow(id);
    await this.access.ensureStoreAccess(
      priceGroup.storeId,
      user,
      'manage_price_groups',
    );
    const data: Prisma.PriceGroupUpdateInput = {};

    if (body.name !== undefined) {
      data.name = this.requiredString(body.name, 'name');
    }

    if (body.description !== undefined) {
      data.description = this.optionalString(body.description, 'description');
    }

    try {
      return await this.prisma.priceGroup.update({ where: { id }, data });
    } catch (error) {
      this.handleSetupNameConflict(error, 'price group');
      throw error;
    }
  }

  async deletePriceGroup(id: string, user: AuthTokenPayload) {
    const priceGroup = await this.findPriceGroupOrThrow(id);
    await this.access.ensureStoreAccess(
      priceGroup.storeId,
      user,
      'manage_price_groups',
    );
    await this.ensureSetupTableNotInUse(
      { priceGroupId: id },
      'Price group is used by products and cannot be deleted',
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
    await this.access.ensureStoreAccess(
      dto.storeId,
      user,
      'manage_product_categories',
    );

    try {
      return await this.prisma.productCategory.create({ data: dto });
    } catch (error) {
      this.handleSetupNameConflict(error, 'product category');
      throw error;
    }
  }

  async listProductCategories(storeId: string, user: AuthTokenPayload) {
    await this.access.ensureStoreAccess(
      storeId,
      user,
      'manage_product_categories',
    );

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
      'manage_product_categories',
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
      'manage_product_categories',
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
    await this.access.ensureStoreAccess(dto.storeId, user, 'manage_taxes');

    try {
      return await this.prisma.tax.create({ data: dto });
    } catch (error) {
      this.handleSetupNameConflict(error, 'tax');
      throw error;
    }
  }

  async listTaxes(storeId: string, user: AuthTokenPayload) {
    await this.access.ensureStoreAccess(storeId, user, 'manage_taxes');

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
    await this.access.ensureStoreAccess(tax.storeId, user, 'manage_taxes');
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
    await this.access.ensureStoreAccess(tax.storeId, user, 'manage_taxes');
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
      taxId: dto.taxId,
    });
    const calculated = this.calculateProductFields(dto);

    try {
      return await this.prisma.product.create({
        data: {
          ...dto,
          ...calculated,
          allowEbt: dto.allowEbt ?? relations.department.defaultAllowEbt,
        },
        include: this.productInclude,
      });
    } catch (error) {
      this.handleBarcodeConflict(error);
      throw error;
    }
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
      taxId: next.taxId,
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

    if (dto.departmentId !== undefined && dto.allowEbt === undefined) {
      data.allowEbt = relations.department.defaultAllowEbt;
    }

    try {
      return await this.prisma.product.update({
        where: { id: productId },
        data,
        include: this.productInclude,
      });
    } catch (error) {
      this.handleBarcodeConflict(error);
      throw error;
    }
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
        barcode: this.requiredString(barcode, 'barcode'),
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

    return this.prisma.product.update({
      where: { id: productId },
      data: { isActive: false },
      include: this.productInclude,
    });
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

  private async findPriceGroupOrThrow(id: string) {
    const priceGroup = await this.prisma.priceGroup.findUnique({
      where: { id },
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
      priceGroupId: string;
      productCategoryId: string;
      taxId: string;
    },
  ) {
    const [department, priceGroup, productCategory, tax] = await Promise.all([
      this.prisma.department.findFirst({
        where: { id: ids.departmentId, storeId, isActive: true },
      }),
      this.prisma.priceGroup.findFirst({
        where: { id: ids.priceGroupId, storeId, isActive: true },
      }),
      this.prisma.productCategory.findFirst({
        where: { id: ids.productCategoryId, storeId, isActive: true },
      }),
      this.prisma.tax.findFirst({
        where: { id: ids.taxId, storeId, isActive: true },
      }),
    ]);

    if (!department) {
      throw new BadRequestException(
        'departmentId must belong to the product store',
      );
    }

    if (!priceGroup) {
      throw new BadRequestException(
        'priceGroupId must belong to the product store',
      );
    }

    if (!productCategory) {
      throw new BadRequestException(
        'productCategoryId must belong to the product store',
      );
    }

    if (!tax) {
      throw new BadRequestException('taxId must belong to the product store');
    }

    return { department, priceGroup, productCategory, tax };
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

  private parseCreateBody(body: Record<string, unknown>): ProductCreateDto {
    return {
      storeId: this.requiredString(body.storeId, 'storeId'),
      barcode: this.requiredString(body.barcode, 'barcode'),
      name: this.requiredString(body.name, 'name'),
      departmentId: this.requiredString(body.departmentId, 'departmentId'),
      priceGroupId: this.requiredString(body.priceGroupId, 'priceGroupId'),
      productCategoryId: this.requiredString(
        body.productCategoryId,
        'productCategoryId',
      ),
      saleType: this.requiredEnum(body.saleType, 'saleType', ProductSaleType),
      currentQuantity:
        this.optionalInt(body.currentQuantity, 'currentQuantity') ?? 0,
      unitsPerCase: this.optionalPositiveInt(body.unitsPerCase, 'unitsPerCase'),
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
      taxId: this.requiredString(body.taxId, 'taxId'),
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
      taxStyle: this.requiredEnum(body.taxStyle, 'taxStyle', TaxStyle),
    };
  }

  private parseUpdateBody(body: Record<string, unknown>): ProductUpdateDto {
    const updates: ProductUpdateDto = {};

    if (body.barcode !== undefined)
      updates.barcode = this.requiredString(body.barcode, 'barcode');
    if (body.name !== undefined)
      updates.name = this.requiredString(body.name, 'name');
    if (body.departmentId !== undefined)
      updates.departmentId = this.requiredString(
        body.departmentId,
        'departmentId',
      );
    if (body.priceGroupId !== undefined)
      updates.priceGroupId = this.requiredString(
        body.priceGroupId,
        'priceGroupId',
      );
    if (body.productCategoryId !== undefined)
      updates.productCategoryId = this.requiredString(
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
      updates.unitsPerCase = this.optionalPositiveInt(
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
      updates.taxId = this.requiredString(body.taxId, 'taxId');
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
    if (body.taxStyle !== undefined)
      updates.taxStyle = this.requiredEnum(body.taxStyle, 'taxStyle', TaxStyle);

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

  private optionalPositiveInt(value: unknown, field: string) {
    const parsed = this.optionalInt(value, field);

    if (parsed !== null && parsed <= 0) {
      throw new BadRequestException(`${field} must be greater than zero`);
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
      throw new ConflictException('A product with that barcode already exists');
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

  private readonly productInclude = {
    department: true,
    priceGroup: true,
    productCategory: true,
    tax: true,
    store: true,
  } satisfies Prisma.ProductInclude;
}

type ProductCreateDto = ProductCalculationInput & {
  storeId: string;
  barcode: string;
  name: string;
  departmentId: string;
  priceGroupId: string;
  productCategoryId: string;
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
  taxStyle: TaxStyle;
};

type ProductUpdateDto = Partial<Omit<ProductCreateDto, 'storeId'>>;

type ProductCalculationInput = {
  unitsPerCase?: number | null;
  caseCost?: number | null;
  caseDiscount: number;
  caseRebate: number;
  unitRetail: number;
};
