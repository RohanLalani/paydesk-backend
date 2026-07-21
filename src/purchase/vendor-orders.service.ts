import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  PayeeType,
  Prisma,
  PurchaseStatus,
  PurchaseType,
  StorePermissionKey,
  StoreSubscriptionStatus,
  SubscriptionPlan,
  TransactionStatus,
  VendorOrderStatus,
} from '@prisma/client';
import { AuthTokenPayload } from '../auth/strategies/jwt.strategy';
import { PosAccessService } from '../common/pos-access.service';
import { PrismaService } from '../prisma.service';
import { PurchaseService } from './purchase.service';

const DEFAULT_LOOKBACK_DAYS = 30;
const DEFAULT_COVERAGE_DAYS = 14;
const MAX_LOOKBACK_DAYS = 180;
const MAX_COVERAGE_DAYS = 90;

type VendorOrderWithDetail = Prisma.VendorOrderGetPayload<{
  include: VendorOrdersService['orderInclude'];
}>;

@Injectable()
export class VendorOrdersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: PosAccessService,
    private readonly purchaseService: PurchaseService,
  ) {}

  async listProductVendors(
    storeId: string,
    query: Record<string, unknown>,
    user: AuthTokenPayload,
  ) {
    await this.assertVendorOrdersAvailable(
      storeId,
      user,
      StorePermissionKey.view_purchases,
    );
    const search = this.optionalSearch(query.search, 'search');
    const active = this.optionalQueryBoolean(query.active, 'active');

    const items = await this.prisma.productVendor.findMany({
      where: {
        storeId,
        ...(active === undefined ? {} : { isActive: active }),
        ...(search
          ? {
              OR: [
                { vendorSku: { contains: search, mode: 'insensitive' } },
                {
                  product: { name: { contains: search, mode: 'insensitive' } },
                },
                {
                  product: {
                    barcode: { contains: search, mode: 'insensitive' },
                  },
                },
                { payee: { name: { contains: search, mode: 'insensitive' } } },
              ],
            }
          : {}),
      },
      orderBy: [{ product: { name: 'asc' } }, { payee: { name: 'asc' } }],
      include: this.productVendorInclude,
    });

    return {
      items: items.map((item) => this.serializeProductVendor(item)),
      total: items.length,
    };
  }

  async createProductVendor(
    storeId: string,
    body: Record<string, unknown>,
    user: AuthTokenPayload,
  ) {
    await this.assertVendorOrdersAvailable(
      storeId,
      user,
      StorePermissionKey.manage_purchases,
    );
    const dto = this.parseProductVendorBody(body, true);
    await this.ensureActiveProductInStore(storeId, dto.productId);
    await this.ensureVendorPayeeInStore(storeId, dto.payeeId);

    try {
      const created = await this.prisma.productVendor.create({
        data: {
          storeId,
          productId: dto.productId!,
          payeeId: dto.payeeId!,
          vendorSku: dto.vendorSku,
          unitsPerCase: dto.unitsPerCase ?? 1,
          caseCost: dto.caseCost!,
          caseDiscount: dto.caseDiscount,
          minOrderQuantity: dto.minOrderQuantity,
          leadTimeDays: dto.leadTimeDays,
          isPreferred: dto.isPreferred,
          isActive: dto.isActive,
        },
        include: this.productVendorInclude,
      });

      return this.serializeProductVendor(created);
    } catch (error) {
      this.handleProductVendorConflict(error);
      throw error;
    }
  }

  async updateProductVendor(
    storeId: string,
    productVendorId: string,
    body: Record<string, unknown>,
    user: AuthTokenPayload,
  ) {
    await this.assertVendorOrdersAvailable(
      storeId,
      user,
      StorePermissionKey.manage_purchases,
    );
    const existing = await this.findProductVendorOrThrow(
      storeId,
      productVendorId,
    );
    const dto = this.parseProductVendorBody(body, false);

    if (dto.productId !== undefined) {
      await this.ensureActiveProductInStore(storeId, dto.productId);
    }
    if (dto.payeeId !== undefined) {
      await this.ensureVendorPayeeInStore(storeId, dto.payeeId);
    }

    try {
      const updated = await this.prisma.productVendor.update({
        where: { id: existing.id },
        data: dto,
        include: this.productVendorInclude,
      });

      return this.serializeProductVendor(updated);
    } catch (error) {
      this.handleProductVendorConflict(error);
      throw error;
    }
  }

  async deleteProductVendor(
    storeId: string,
    productVendorId: string,
    user: AuthTokenPayload,
  ) {
    await this.assertVendorOrdersAvailable(
      storeId,
      user,
      StorePermissionKey.manage_purchases,
    );
    const existing = await this.findProductVendorOrThrow(
      storeId,
      productVendorId,
    );
    const updated = await this.prisma.productVendor.update({
      where: { id: existing.id },
      data: { isActive: false },
      include: this.productVendorInclude,
    });

    return this.serializeProductVendor(updated);
  }

  async listOrders(
    storeId: string,
    query: Record<string, unknown>,
    user: AuthTokenPayload,
  ) {
    await this.assertVendorOrdersAvailable(
      storeId,
      user,
      StorePermissionKey.view_purchases,
    );
    const status = this.optionalEnum(query.status, 'status', VendorOrderStatus);

    const orders = await this.prisma.vendorOrder.findMany({
      where: {
        storeId,
        ...(status ? { status } : {}),
      },
      orderBy: { createdAt: 'desc' },
      include: this.orderInclude,
    });

    return {
      items: orders.map((order) => this.serializeOrder(order)),
      total: orders.length,
    };
  }

  async generateOrders(
    storeId: string,
    body: Record<string, unknown>,
    user: AuthTokenPayload,
  ) {
    await this.assertVendorOrdersAvailable(
      storeId,
      user,
      StorePermissionKey.manage_purchases,
    );
    const lookbackDays =
      this.optionalPositiveInt(
        body.lookbackDays,
        'lookbackDays',
        DEFAULT_LOOKBACK_DAYS,
        MAX_LOOKBACK_DAYS,
      ) ?? DEFAULT_LOOKBACK_DAYS;
    const coverageDays =
      this.optionalPositiveInt(
        body.coverageDays,
        'coverageDays',
        DEFAULT_COVERAGE_DAYS,
        MAX_COVERAGE_DAYS,
      ) ?? DEFAULT_COVERAGE_DAYS;
    const onlyBelowMin =
      body.onlyBelowMin === undefined
        ? true
        : this.requiredBoolean(body.onlyBelowMin, 'onlyBelowMin');
    const since = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000);

    const [products, sales] = await Promise.all([
      this.prisma.product.findMany({
        where: {
          storeId,
          isActive: true,
          trackInventory: true,
          minInventory: { not: null },
        },
        include: {
          productVendors: {
            where: {
              isActive: true,
              payee: {
                isActive: true,
                payeeType: PayeeType.VENDOR,
              },
            },
            include: { payee: true },
          },
        },
      }),
      this.prisma.transactionItem.groupBy({
        by: ['productId'],
        where: {
          transaction: {
            storeId,
            transactionStatus: TransactionStatus.completed,
            createdAt: { gte: since },
          },
        },
        _sum: { quantity: true },
      }),
    ]);
    const salesByProduct = new Map(
      sales.map((sale) => [sale.productId, sale._sum.quantity ?? 0]),
    );
    const grouped = new Map<
      string,
      Array<{
        product: (typeof products)[number];
        vendor: (typeof products)[number]['productVendors'][number];
        suggestedCases: number;
        suggestedUnits: number;
        recentSales: number;
      }>
    >();
    const skipped: Array<{ productId: string; reason: string }> = [];

    for (const product of products) {
      const minInventory = product.minInventory ?? 0;
      const maxInventory = product.maxInventory ?? null;
      const recentSales = salesByProduct.get(product.id) ?? 0;
      const averageDailySales = recentSales / lookbackDays;
      const targetUnits = Math.max(
        minInventory,
        Math.ceil(
          maxInventory ?? minInventory + averageDailySales * coverageDays,
        ),
      );

      if (onlyBelowMin && product.currentQuantity >= minInventory) {
        continue;
      }

      const suggestedUnits = Math.max(0, targetUnits - product.currentQuantity);

      if (suggestedUnits <= 0) {
        continue;
      }

      const vendor = this.chooseCheapestVendor(product.productVendors);

      if (!vendor) {
        skipped.push({ productId: product.id, reason: 'No active vendor' });
        continue;
      }

      const suggestedCases = Math.max(
        vendor.minOrderQuantity ?? 1,
        Math.ceil(suggestedUnits / vendor.unitsPerCase),
      );
      const vendorItems = grouped.get(vendor.payeeId) ?? [];
      vendorItems.push({
        product,
        vendor,
        suggestedCases,
        suggestedUnits,
        recentSales,
      });
      grouped.set(vendor.payeeId, vendorItems);
    }

    const created = await this.prisma.$transaction(async (tx) => {
      const orders: VendorOrderWithDetail[] = [];

      for (const [payeeId, items] of grouped) {
        const estimatedCost = items.reduce(
          (sum, item) =>
            sum.add(this.caseNetCost(item.vendor).mul(item.suggestedCases)),
          new Prisma.Decimal(0),
        );
        const order = await tx.vendorOrder.create({
          data: {
            storeId,
            payeeId,
            status: VendorOrderStatus.DRAFT,
            estimatedCost,
            createdByActorId: user.staffId,
            updatedByActorId: user.staffId,
            notes: `Generated from ${lookbackDays} days of sales history.`,
            items: {
              create: items.map((item) =>
                this.orderItemCreateData(
                  item.product,
                  item.vendor,
                  item.suggestedCases,
                ),
              ),
            },
          },
          include: this.orderInclude,
        });
        orders.push(order);
      }

      return orders;
    });

    return {
      orders: created.map((order) => this.serializeOrder(order)),
      skipped,
      lookbackDays,
      coverageDays,
    };
  }

  async getOrder(storeId: string, orderId: string, user: AuthTokenPayload) {
    await this.assertVendorOrdersAvailable(
      storeId,
      user,
      StorePermissionKey.view_purchases,
    );
    const order = await this.findOrderOrThrow(storeId, orderId);

    return this.serializeOrder(order);
  }

  async updateOrder(
    storeId: string,
    orderId: string,
    body: Record<string, unknown>,
    user: AuthTokenPayload,
  ) {
    await this.assertVendorOrdersAvailable(
      storeId,
      user,
      StorePermissionKey.manage_purchases,
    );
    const order = await this.findOrderOrThrow(storeId, orderId);

    if (
      order.status === VendorOrderStatus.RECEIVED ||
      order.status === VendorOrderStatus.CANCELLED
    ) {
      throw new BadRequestException(
        'Received or cancelled orders cannot be edited',
      );
    }

    const status =
      body.status === undefined
        ? undefined
        : this.requiredEnum(body.status, 'status', VendorOrderStatus);
    const notes =
      body.notes === undefined
        ? undefined
        : this.optionalString(body.notes, 'notes');
    const itemUpdates =
      body.items === undefined
        ? undefined
        : this.parseOrderItemUpdates(body.items);

    if (status === VendorOrderStatus.SENT) {
      throw new BadRequestException('Use the Send action to send an order');
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      if (itemUpdates) {
        for (const item of itemUpdates) {
          const existingItem = order.items.find(
            (candidate) => candidate.id === item.id,
          );

          if (!existingItem) {
            throw new BadRequestException(
              `Order item ${item.id} was not found`,
            );
          }

          if (item.remove) {
            await tx.vendorOrderItem.delete({ where: { id: item.id } });
            continue;
          }

          await tx.vendorOrderItem.update({
            where: { id: item.id },
            data: {
              quantityOrdered: item.quantityOrdered,
              extendedCost: this.orderItemExtendedCost(
                existingItem.caseCost,
                existingItem.caseDiscount,
                item.quantityOrdered,
              ),
            },
          });
        }
      }

      const freshItems = await tx.vendorOrderItem.findMany({
        where: { vendorOrderId: order.id },
      });
      const estimatedCost = freshItems.reduce(
        (sum, item) => sum.add(item.extendedCost),
        new Prisma.Decimal(0),
      );

      return tx.vendorOrder.update({
        where: { id: order.id },
        data: {
          ...(status ? { status } : {}),
          ...(notes !== undefined ? { notes } : {}),
          estimatedCost,
          updatedByActorId: user.staffId,
        },
        include: this.orderInclude,
      });
    });

    return this.serializeOrder(updated);
  }

  async sendOrder(storeId: string, orderId: string, user: AuthTokenPayload) {
    await this.assertVendorOrdersAvailable(
      storeId,
      user,
      StorePermissionKey.manage_purchases,
    );
    const order = await this.findOrderOrThrow(storeId, orderId);

    if (
      order.status !== VendorOrderStatus.DRAFT &&
      order.status !== VendorOrderStatus.READY
    ) {
      throw new BadRequestException('Only draft or ready orders can be sent');
    }

    const updated = await this.prisma.vendorOrder.update({
      where: { id: order.id },
      data: {
        status: VendorOrderStatus.SENT,
        sentAt: new Date(),
        updatedByActorId: user.staffId,
      },
      include: this.orderInclude,
    });

    return this.serializeOrder(updated);
  }

  async receiveOrder(
    storeId: string,
    orderId: string,
    body: Record<string, unknown>,
    user: AuthTokenPayload,
  ) {
    await this.assertVendorOrdersAvailable(
      storeId,
      user,
      StorePermissionKey.manage_purchases,
    );
    const order = await this.findOrderOrThrow(storeId, orderId);

    if (
      order.status === VendorOrderStatus.CANCELLED ||
      order.status === VendorOrderStatus.RECEIVED
    ) {
      throw new BadRequestException('This order cannot receive more items');
    }

    const receivedItems = this.parseReceiveItems(body.items);
    const deltas: Array<(typeof order.items)[number] & { delta: number }> = [];

    for (const received of receivedItems) {
      const item = order.items.find(
        (candidate) => candidate.id === received.id,
      );

      if (!item) {
        throw new BadRequestException(
          `Order item ${received.id} was not found`,
        );
      }

      if (received.quantityReceived < item.quantityReceived) {
        throw new BadRequestException(
          `items.${received.id}.quantityReceived cannot be less than already received`,
        );
      }

      if (received.quantityReceived > item.quantityOrdered) {
        throw new BadRequestException(
          `items.${received.id}.quantityReceived cannot exceed ordered quantity`,
        );
      }

      const delta = received.quantityReceived - item.quantityReceived;

      if (delta > 0) {
        deltas.push({ ...item, delta });
      }
    }

    if (!deltas.length) {
      throw new BadRequestException(
        'At least one new received quantity is required',
      );
    }

    const purchase = await this.purchaseService.createStorePurchase(
      storeId,
      {
        payeeId: order.payeeId,
        invoiceNumber: `ORDER-${order.id.slice(0, 8)}-${Date.now()}`,
        purchaseDate: new Date().toISOString(),
        type: PurchaseType.CREDIT,
        status: PurchaseStatus.OPEN,
        referenceNumber: order.id,
        notes: `Received from vendor order ${order.id}`,
        items: deltas.map((item) => ({
          productId: item.productId,
          quantity: item.delta,
          unitsPerCase: item.unitsPerCase,
          caseCost: item.caseCost.toFixed(2),
          caseDiscount: item.caseDiscount.toFixed(2),
          unitRetailSnapshot: item.product.unitRetail.toFixed(2),
          entryType: 'purchase',
          source: 'vendor_order',
        })),
        expenses: [],
      },
      user,
    );

    const updated = await this.prisma.$transaction(async (tx) => {
      for (const item of receivedItems) {
        await tx.vendorOrderItem.update({
          where: { id: item.id },
          data: { quantityReceived: item.quantityReceived },
        });
      }

      const freshItems = await tx.vendorOrderItem.findMany({
        where: { vendorOrderId: order.id },
      });
      const allReceived = freshItems.every(
        (item) => item.quantityReceived >= item.quantityOrdered,
      );

      return tx.vendorOrder.update({
        where: { id: order.id },
        data: {
          status: allReceived
            ? VendorOrderStatus.RECEIVED
            : VendorOrderStatus.PARTIALLY_RECEIVED,
          receivedAt: allReceived ? new Date() : order.receivedAt,
          purchaseId: purchase.id,
          updatedByActorId: user.staffId,
        },
        include: this.orderInclude,
      });
    });

    return {
      order: this.serializeOrder(updated),
      purchase,
    };
  }

  private async assertVendorOrdersAvailable(
    storeId: string,
    user: AuthTokenPayload,
    permission: StorePermissionKey,
  ) {
    await this.access.ensureStoreAccess(storeId, user, permission);
    const store = await this.prisma.store.findUnique({
      where: { id: storeId },
      include: { storeSubscription: true },
    });

    if (!store) {
      throw new NotFoundException('Store not found');
    }

    if (
      !store.isActive ||
      store.storeSubscription?.plan !== SubscriptionPlan.advanced ||
      store.storeSubscription.status !== StoreSubscriptionStatus.active
    ) {
      throw new ForbiddenException(
        'Orders is available with the Advanced plan.',
      );
    }

    return store;
  }

  private async findProductVendorOrThrow(storeId: string, id: string) {
    const productVendor = await this.prisma.productVendor.findFirst({
      where: { id, storeId },
      include: this.productVendorInclude,
    });

    if (!productVendor) {
      throw new NotFoundException('Product vendor was not found');
    }

    return productVendor;
  }

  private async findOrderOrThrow(storeId: string, orderId: string) {
    const order = await this.prisma.vendorOrder.findFirst({
      where: { id: orderId, storeId },
      include: this.orderInclude,
    });

    if (!order) {
      throw new NotFoundException('Vendor order was not found');
    }

    return order;
  }

  private async ensureActiveProductInStore(
    storeId: string,
    productId?: string,
  ) {
    if (!productId) {
      throw new BadRequestException('productId is required');
    }

    const product = await this.prisma.product.findFirst({
      where: { id: productId, storeId, isActive: true },
      select: { id: true },
    });

    if (!product) {
      throw new BadRequestException('Product does not belong to this store');
    }
  }

  private async ensureVendorPayeeInStore(storeId: string, payeeId?: string) {
    if (!payeeId) {
      throw new BadRequestException('payeeId is required');
    }

    const payee = await this.prisma.payee.findFirst({
      where: {
        id: payeeId,
        storeId,
        isActive: true,
        payeeType: PayeeType.VENDOR,
      },
      select: { id: true },
    });

    if (!payee) {
      throw new BadRequestException('Payee must be an active vendor');
    }
  }

  private parseProductVendorBody(
    body: Record<string, unknown>,
    requireRequiredFields: boolean,
  ) {
    const data: {
      productId?: string;
      payeeId?: string;
      vendorSku?: string | null;
      unitsPerCase?: number;
      caseCost?: Prisma.Decimal;
      caseDiscount?: Prisma.Decimal;
      minOrderQuantity?: number | null;
      leadTimeDays?: number | null;
      isPreferred?: boolean;
      isActive?: boolean;
    } = {};

    if (requireRequiredFields || body.productId !== undefined) {
      data.productId = this.requiredString(body.productId, 'productId');
    }
    if (requireRequiredFields || body.payeeId !== undefined) {
      data.payeeId = this.requiredString(body.payeeId, 'payeeId');
    }
    if (body.vendorSku !== undefined) {
      data.vendorSku = this.optionalString(body.vendorSku, 'vendorSku');
    }
    if (requireRequiredFields || body.unitsPerCase !== undefined) {
      data.unitsPerCase =
        this.optionalPositiveInt(body.unitsPerCase, 'unitsPerCase', 1) ??
        undefined;
    }
    if (requireRequiredFields || body.caseCost !== undefined) {
      data.caseCost = this.requiredDecimal(body.caseCost, 'caseCost', 2);
    }
    if (body.caseDiscount !== undefined) {
      data.caseDiscount = this.requiredDecimal(
        body.caseDiscount,
        'caseDiscount',
        2,
      );
    }
    if (body.minOrderQuantity !== undefined) {
      data.minOrderQuantity = this.optionalPositiveInt(
        body.minOrderQuantity,
        'minOrderQuantity',
      );
    }
    if (body.leadTimeDays !== undefined) {
      data.leadTimeDays = this.optionalPositiveInt(
        body.leadTimeDays,
        'leadTimeDays',
      );
    }
    if (body.isPreferred !== undefined) {
      data.isPreferred = this.requiredBoolean(body.isPreferred, 'isPreferred');
    }
    if (body.isActive !== undefined) {
      data.isActive = this.requiredBoolean(body.isActive, 'isActive');
    }

    if (!requireRequiredFields && !Object.keys(data).length) {
      throw new BadRequestException('At least one field is required');
    }

    return data;
  }

  private parseOrderItemUpdates(value: unknown) {
    if (!Array.isArray(value)) {
      throw new BadRequestException('items must be an array');
    }

    return value.map((item, index) => {
      if (!this.isObject(item)) {
        throw new BadRequestException(`items.${index} must be an object`);
      }

      const remove =
        item.remove === undefined
          ? false
          : this.requiredBoolean(item.remove, `items.${index}.remove`);

      return {
        id: this.requiredString(item.id, `items.${index}.id`),
        remove,
        quantityOrdered: remove
          ? 0
          : this.requiredPositiveInt(
              item.quantityOrdered,
              `items.${index}.quantityOrdered`,
            ),
      };
    });
  }

  private parseReceiveItems(value: unknown) {
    if (!Array.isArray(value)) {
      throw new BadRequestException('items must be an array');
    }

    return value.map((item, index) => {
      if (!this.isObject(item)) {
        throw new BadRequestException(`items.${index} must be an object`);
      }

      return {
        id: this.requiredString(item.id, `items.${index}.id`),
        quantityReceived: this.requiredInt(
          item.quantityReceived,
          `items.${index}.quantityReceived`,
        ),
      };
    });
  }

  private chooseCheapestVendor<
    T extends {
      caseCost: Prisma.Decimal;
      caseDiscount: Prisma.Decimal;
      unitsPerCase: number;
      isPreferred: boolean;
    },
  >(vendors: T[]) {
    return vendors
      .filter((vendor) => vendor.unitsPerCase > 0)
      .sort((a, b) => {
        const costComparison = this.caseUnitCost(a).cmp(this.caseUnitCost(b));

        if (costComparison !== 0) {
          return costComparison;
        }

        if (a.isPreferred !== b.isPreferred) {
          return a.isPreferred ? -1 : 1;
        }

        return 0;
      })[0];
  }

  private orderItemCreateData(
    product: {
      id: string;
      productNumber: number;
      barcode: string;
      name: string;
    },
    vendor: {
      id: string;
      unitsPerCase: number;
      caseCost: Prisma.Decimal;
      caseDiscount: Prisma.Decimal;
    },
    quantityOrdered: number,
  ): Prisma.VendorOrderItemCreateWithoutVendorOrderInput {
    return {
      product: { connect: { id: product.id } },
      productVendor: { connect: { id: vendor.id } },
      quantityOrdered,
      unitsPerCase: vendor.unitsPerCase,
      caseCost: vendor.caseCost,
      caseDiscount: vendor.caseDiscount,
      unitCost: this.caseUnitCost(vendor),
      extendedCost: this.orderItemExtendedCost(
        vendor.caseCost,
        vendor.caseDiscount,
        quantityOrdered,
      ),
      productNumberSnapshot: product.productNumber,
      barcodeSnapshot: product.barcode,
      productNameSnapshot: product.name,
    };
  }

  private orderItemExtendedCost(
    caseCost: Prisma.Decimal,
    caseDiscount: Prisma.Decimal,
    quantityOrdered: number,
  ) {
    return this.caseNetCost({ caseCost, caseDiscount }).mul(quantityOrdered);
  }

  private caseNetCost(vendor: {
    caseCost: Prisma.Decimal;
    caseDiscount: Prisma.Decimal;
  }) {
    const value = vendor.caseCost.minus(vendor.caseDiscount);
    return value.lessThan(0) ? new Prisma.Decimal(0) : value;
  }

  private caseUnitCost(vendor: {
    caseCost: Prisma.Decimal;
    caseDiscount: Prisma.Decimal;
    unitsPerCase: number;
  }) {
    return this.caseNetCost(vendor).div(vendor.unitsPerCase);
  }

  private serializeProductVendor(
    item: Prisma.ProductVendorGetPayload<{
      include: VendorOrdersService['productVendorInclude'];
    }>,
  ) {
    return {
      id: item.id,
      storeId: item.storeId,
      productId: item.productId,
      payeeId: item.payeeId,
      vendorSku: item.vendorSku,
      unitsPerCase: item.unitsPerCase,
      caseCost: item.caseCost.toFixed(2),
      caseDiscount: item.caseDiscount.toFixed(2),
      unitCost: this.caseUnitCost(item).toFixed(4),
      minOrderQuantity: item.minOrderQuantity,
      leadTimeDays: item.leadTimeDays,
      isPreferred: item.isPreferred,
      isActive: item.isActive,
      product: {
        id: item.product.id,
        productNumber: item.product.productNumber,
        barcode: item.product.barcode,
        name: item.product.name,
        currentQuantity: item.product.currentQuantity,
        minInventory: item.product.minInventory,
        maxInventory: item.product.maxInventory,
      },
      payee: {
        id: item.payee.id,
        name: item.payee.name,
      },
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
    };
  }

  private serializeOrder(order: VendorOrderWithDetail) {
    return {
      id: order.id,
      storeId: order.storeId,
      payeeId: order.payeeId,
      status: order.status,
      estimatedCost: order.estimatedCost.toFixed(2),
      purchaseId: order.purchaseId,
      notes: order.notes,
      sentAt: order.sentAt,
      receivedAt: order.receivedAt,
      cancelledAt: order.cancelledAt,
      payee: {
        id: order.payee.id,
        name: order.payee.name,
      },
      items: order.items.map((item) => ({
        id: item.id,
        productId: item.productId,
        productVendorId: item.productVendorId,
        quantityOrdered: item.quantityOrdered,
        quantityReceived: item.quantityReceived,
        unitsPerCase: item.unitsPerCase,
        caseCost: item.caseCost.toFixed(2),
        caseDiscount: item.caseDiscount.toFixed(2),
        unitCost: item.unitCost.toFixed(4),
        extendedCost: item.extendedCost.toFixed(2),
        productNumber: item.productNumberSnapshot,
        barcode: item.barcodeSnapshot,
        productName: item.productNameSnapshot,
        product: {
          id: item.product.id,
          name: item.product.name,
          barcode: item.product.barcode,
          unitRetail: item.product.unitRetail.toFixed(2),
          currentQuantity: item.product.currentQuantity,
        },
      })),
      createdAt: order.createdAt,
      updatedAt: order.updatedAt,
    };
  }

  private optionalSearch(value: unknown, field: string) {
    if (value === undefined || value === null || value === '') {
      return undefined;
    }

    if (typeof value !== 'string') {
      throw new BadRequestException(`${field} must be a string`);
    }

    const normalized = value.trim().replace(/\s+/g, ' ');
    return normalized || undefined;
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

  private requiredString(value: unknown, field: string) {
    if (typeof value !== 'string' || !value.trim()) {
      throw new BadRequestException(`${field} is required`);
    }

    return value.trim();
  }

  private requiredBoolean(value: unknown, field: string) {
    if (typeof value !== 'boolean') {
      throw new BadRequestException(`${field} must be a boolean`);
    }

    return value;
  }

  private requiredInt(value: unknown, field: string) {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
      throw new BadRequestException(`${field} must be zero or greater`);
    }

    return value;
  }

  private requiredPositiveInt(value: unknown, field: string) {
    const parsed = this.requiredInt(value, field);

    if (parsed <= 0) {
      throw new BadRequestException(`${field} must be greater than zero`);
    }

    return parsed;
  }

  private optionalPositiveInt(
    value: unknown,
    field: string,
    fallback?: number,
    max?: number,
  ) {
    if (value === undefined || value === null || value === '') {
      return fallback ?? null;
    }

    const parsed = this.requiredPositiveInt(value, field);

    if (max !== undefined && parsed > max) {
      throw new BadRequestException(`${field} must be ${max} or fewer`);
    }

    return parsed;
  }

  private requiredDecimal(value: unknown, field: string, maxScale: number) {
    if (
      typeof value !== 'number' &&
      typeof value !== 'string' &&
      !(value instanceof Prisma.Decimal)
    ) {
      throw new BadRequestException(`${field} must be a number`);
    }

    const decimal = new Prisma.Decimal(value);

    if (decimal.isNegative()) {
      throw new BadRequestException(`${field} must be zero or greater`);
    }

    const scale = decimal.decimalPlaces();

    if (scale > maxScale) {
      throw new BadRequestException(
        `${field} must have ${maxScale} decimal places or fewer`,
      );
    }

    return decimal;
  }

  private optionalQueryBoolean(value: unknown, field: string) {
    if (value === undefined || value === null || value === '') {
      return undefined;
    }

    if (value === 'true' || value === true) return true;
    if (value === 'false' || value === false) return false;

    throw new BadRequestException(`${field} must be true or false`);
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

  private optionalEnum<T extends Record<string, string>>(
    value: unknown,
    field: string,
    enumObject: T,
  ) {
    if (value === undefined || value === null || value === '') {
      return undefined;
    }

    return this.requiredEnum(value, field, enumObject);
  }

  private isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }

  private handleProductVendorConflict(error: unknown) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002'
    ) {
      throw new ConflictException(
        'This product is already linked to that vendor.',
      );
    }
  }

  private readonly productVendorInclude = {
    product: {
      select: {
        id: true,
        productNumber: true,
        barcode: true,
        name: true,
        currentQuantity: true,
        minInventory: true,
        maxInventory: true,
      },
    },
    payee: { select: { id: true, name: true } },
  } satisfies Prisma.ProductVendorInclude;

  private readonly orderInclude = {
    payee: { select: { id: true, name: true } },
    items: {
      orderBy: { productNameSnapshot: 'asc' },
      include: {
        product: {
          select: {
            id: true,
            name: true,
            barcode: true,
            unitRetail: true,
            currentQuantity: true,
          },
        },
      },
    },
  } satisfies Prisma.VendorOrderInclude;
}
