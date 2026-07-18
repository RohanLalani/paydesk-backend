import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import {
  AuditAction,
  AuditEntityType,
  Prisma,
  PayeeType,
  PurchaseStatus,
  PurchaseType,
  StorePermissionKey,
} from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { AuthTokenPayload } from '../auth/strategies/jwt.strategy';
import { PosAccessService } from '../common/pos-access.service';
import { PrismaService } from '../prisma.service';

type AuditRecorder = {
  record: (...args: Parameters<AuditService['record']>) => Promise<unknown>;
};

const NOOP_AUDIT: AuditRecorder = { record: () => Promise.resolve(null) };
const PURCHASE_SORT_FIELDS = [
  'purchaseDate',
  'payee',
  'invoiceNumber',
  'type',
  'costSubtotal',
  'retailTotal',
  'totalCost',
  'margin',
] as const;

type PurchaseSortField = (typeof PURCHASE_SORT_FIELDS)[number];

@Injectable()
export class PurchaseService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: PosAccessService,
    @Optional()
    private readonly audit: AuditService = NOOP_AUDIT as unknown as AuditService,
  ) {}

  async listStorePayees(
    storeId: string,
    query: Record<string, unknown>,
    user: AuthTokenPayload,
  ) {
    await this.ensurePayeeReadAccess(storeId, user);
    const active = this.optionalQueryBoolean(query.active, 'active');
    const search = this.optionalSearch(query.search, 'search');
    const pagination = this.parsePageLimit(query, 100);

    const where: Prisma.PayeeWhereInput = {
      storeId,
      ...(active === undefined ? {} : { isActive: active }),
      ...(search ? { name: { contains: search, mode: 'insensitive' } } : {}),
    };

    const [items, total] = await Promise.all([
      this.prisma.payee.findMany({
        where,
        orderBy: [{ isActive: 'desc' }, { name: 'asc' }],
        skip: pagination.skip,
        take: pagination.limit,
      }),
      this.prisma.payee.count({ where }),
    ]);

    return {
      items: items.map((payee) => this.serializePayee(payee)),
      total,
      page: pagination.page,
      limit: pagination.limit,
    };
  }

  async createStorePayee(
    storeId: string,
    body: Record<string, unknown>,
    user: AuthTokenPayload,
  ) {
    await this.access.ensureStoreAccess(
      storeId,
      user,
      StorePermissionKey.manage_payees,
    );
    const data = this.parseCreatePayeeBody(body);

    try {
      const payee = await this.prisma.$transaction(async (tx) => {
        const created = await tx.payee.create({
          data: { storeId, ...data },
        });

        await this.audit.record(tx, {
          storeId,
          actorId: user.staffId,
          ownerId: user.type === 'owner' ? user.accountId : null,
          action: AuditAction.create,
          entityType: AuditEntityType.payee,
          entityId: created.id,
          entityName: created.name,
          summary: `Created payee ${created.name}`,
          after: created,
        });

        return created;
      });

      return this.serializePayee(payee);
    } catch (error) {
      this.handlePayeeConflict(error);
      throw error;
    }
  }

  async getStorePayee(
    storeId: string,
    payeeId: string,
    user: AuthTokenPayload,
  ) {
    await this.ensurePayeeReadAccess(storeId, user);
    const payee = await this.findPayeeInStoreOrThrow(payeeId, storeId);
    return this.serializePayee(payee);
  }

  async updateStorePayee(
    storeId: string,
    payeeId: string,
    body: Record<string, unknown>,
    user: AuthTokenPayload,
  ) {
    await this.access.ensureStoreAccess(
      storeId,
      user,
      StorePermissionKey.manage_payees,
    );
    const payee = await this.findPayeeInStoreOrThrow(payeeId, storeId);
    const data = this.parseUpdatePayeeBody(body);

    try {
      const updated = await this.prisma.$transaction(async (tx) => {
        const next = await tx.payee.update({
          where: { id: payeeId },
          data,
        });

        await this.audit.record(tx, {
          storeId,
          actorId: user.staffId,
          ownerId: user.type === 'owner' ? user.accountId : null,
          action:
            data.isActive === false
              ? AuditAction.deactivate
              : data.isActive === true && !payee.isActive
                ? AuditAction.activate
                : AuditAction.update,
          entityType: AuditEntityType.payee,
          entityId: next.id,
          entityName: next.name,
          summary: `Updated payee ${next.name}`,
          before: payee,
          after: next,
        });

        return next;
      });

      return this.serializePayee(updated);
    } catch (error) {
      this.handlePayeeConflict(error);
      throw error;
    }
  }

  async listStorePurchases(
    storeId: string,
    query: Record<string, unknown>,
    user: AuthTokenPayload,
  ) {
    await this.access.ensureStoreAccess(
      storeId,
      user,
      StorePermissionKey.view_purchases,
    );
    const search = this.optionalSearch(query.search, 'search');
    const payeeId = this.optionalString(query.payeeId, 'payeeId');
    const type = this.optionalEnum(query.type, 'type', PurchaseType);
    const status = this.optionalEnum(query.status, 'status', PurchaseStatus);
    const { dateFrom, dateTo } = this.resolveDateRange(query);
    const sort = this.optionalSort(
      query.sort,
      PURCHASE_SORT_FIELDS,
      'purchaseDate',
      'sort',
    );
    const order = this.optionalSort(
      query.order,
      ['asc', 'desc'],
      'desc',
      'order',
    );
    const pagination = this.parsePageLimit(query, 25);
    const purchaseNumber =
      search && this.isPositiveIntegerText(search) ? Number(search) : null;

    const where: Prisma.PurchaseWhereInput = {
      storeId,
      purchaseDate: { gte: dateFrom, lte: dateTo },
      ...(payeeId ? { payeeId } : {}),
      ...(type ? { type } : {}),
      ...(status ? { status } : {}),
      ...(search
        ? {
            OR: [
              { invoiceNumber: { contains: search, mode: 'insensitive' } },
              { payee: { name: { contains: search, mode: 'insensitive' } } },
              ...(purchaseNumber ? [{ purchaseNumber }] : []),
              { notes: { contains: search, mode: 'insensitive' } },
            ],
          }
        : {}),
    };

    const [items, total, totals] = await Promise.all([
      this.prisma.purchase.findMany({
        where,
        select: this.purchaseListSelect,
        orderBy: this.purchaseListOrderBy(sort, order),
        skip: pagination.skip,
        take: pagination.limit,
      }),
      this.prisma.purchase.count({ where }),
      this.prisma.purchase.aggregate({
        where,
        _sum: {
          costSubtotal: true,
          retailTotal: true,
          totalCost: true,
        },
      }),
    ]);

    const sumRetail = totals._sum.retailTotal ?? new Prisma.Decimal(0);
    const sumTotalCost = totals._sum.totalCost ?? new Prisma.Decimal(0);

    return {
      items: items.map((purchase) => this.serializePurchaseListItem(purchase)),
      total,
      page: pagination.page,
      limit: pagination.limit,
      totalPages: Math.max(1, Math.ceil(total / pagination.limit)),
      totals: {
        costSubtotal: (
          totals._sum.costSubtotal ?? new Prisma.Decimal(0)
        ).toFixed(2),
        retailTotal: sumRetail.toFixed(2),
        totalCost: sumTotalCost.toFixed(2),
        marginPercent: this.calculateMarginPercent(sumRetail, sumTotalCost),
      },
    };
  }

  async createStorePurchase(
    storeId: string,
    body: Record<string, unknown>,
    user: AuthTokenPayload,
  ) {
    await this.access.ensureStoreAccess(
      storeId,
      user,
      StorePermissionKey.manage_purchases,
    );
    const dto = this.parseCreatePurchaseBody(body);
    const payee = await this.ensureActivePayeeInStore(dto.payeeId, storeId);
    const itemInputs = await this.resolvePurchaseItems(storeId, dto.items);
    const totals = this.calculatePurchaseTotals(itemInputs, dto.amounts);

    try {
      const created = await this.prisma.$transaction(async (tx) => {
        const store = await tx.store.update({
          where: { id: storeId },
          data: { nextPurchaseNumber: { increment: 1 } },
          select: { nextPurchaseNumber: true },
        });
        const purchaseNumber = store.nextPurchaseNumber - 1;

        const purchase = await tx.purchase.create({
          data: {
            storeId,
            payeeId: payee.id,
            purchaseNumber,
            invoiceNumber: dto.invoiceNumber,
            purchaseDate: dto.purchaseDate,
            type: dto.type,
            status: dto.status,
            referenceNumber: dto.referenceNumber,
            notes: dto.notes,
            freightAmount: totals.freightAmount,
            feeAmount: totals.feeAmount,
            taxAmount: totals.taxAmount,
            discountAmount: totals.discountAmount,
            rebateAmount: totals.rebateAmount,
            costSubtotal: totals.costSubtotal,
            retailTotal: totals.retailTotal,
            totalCost: totals.totalCost,
            marginPercent: totals.marginPercent,
            createdByActorId: user.staffId,
            updatedByActorId: user.staffId,
            items: itemInputs.length
              ? {
                  create: itemInputs.map((item) => ({
                    productId: item.productId,
                    quantity: item.quantity,
                    unitCost: item.unitCost,
                    extendedCost: item.extendedCost,
                    unitRetailSnapshot: item.unitRetailSnapshot,
                    extendedRetail: item.extendedRetail,
                    productNumberSnapshot: item.productNumberSnapshot,
                    barcodeSnapshot: item.barcodeSnapshot,
                    productNameSnapshot: item.productNameSnapshot,
                  })),
                }
              : undefined,
          },
          include: this.purchaseDetailInclude,
        });

        await this.audit.record(tx, {
          storeId,
          actorId: user.staffId,
          ownerId: user.type === 'owner' ? user.accountId : null,
          action: AuditAction.create,
          entityType: AuditEntityType.purchase,
          entityId: purchase.id,
          entityName: purchase.invoiceNumber,
          summary: `Created purchase ${purchase.invoiceNumber}`,
          after: purchase,
        });

        return purchase;
      });

      return this.serializePurchaseDetail(created);
    } catch (error) {
      this.handlePurchaseConflict(error);
      throw error;
    }
  }

  async getStorePurchase(
    storeId: string,
    purchaseId: string,
    user: AuthTokenPayload,
  ) {
    await this.access.ensureStoreAccess(
      storeId,
      user,
      StorePermissionKey.view_purchases,
    );
    const purchase = await this.prisma.purchase.findFirst({
      where: { id: purchaseId, storeId },
      include: this.purchaseDetailInclude,
    });

    if (!purchase) {
      throw new NotFoundException('Purchase not found');
    }

    return this.serializePurchaseDetail(purchase);
  }

  async updateStorePurchase(
    storeId: string,
    purchaseId: string,
    body: Record<string, unknown>,
    user: AuthTokenPayload,
  ) {
    await this.access.ensureStoreAccess(
      storeId,
      user,
      StorePermissionKey.manage_purchases,
    );
    if (body.items !== undefined) {
      throw new BadRequestException(
        'Purchase item editing is not available yet',
      );
    }

    const purchase = await this.prisma.purchase.findFirst({
      where: { id: purchaseId, storeId },
      include: this.purchaseDetailInclude,
    });

    if (!purchase) {
      throw new NotFoundException('Purchase not found');
    }

    const data = this.parseUpdatePurchaseBody(body);
    const payeeId = data.payeeId ?? purchase.payeeId;

    if (data.payeeId) {
      await this.ensureActivePayeeInStore(data.payeeId, storeId);
    }

    const totalCost = this.calculateTotalCost(
      purchase.costSubtotal,
      data.freightAmount ?? purchase.freightAmount,
      data.feeAmount ?? purchase.feeAmount,
      data.taxAmount ?? purchase.taxAmount,
      data.discountAmount ?? purchase.discountAmount,
      data.rebateAmount ?? purchase.rebateAmount,
    );
    const marginPercent = this.calculateMarginDecimal(
      purchase.retailTotal,
      totalCost,
    );

    try {
      const updated = await this.prisma.$transaction(async (tx) => {
        const next = await tx.purchase.update({
          where: { id: purchaseId },
          data: {
            ...(data.invoiceNumber === undefined
              ? {}
              : { invoiceNumber: data.invoiceNumber }),
            ...(data.purchaseDate === undefined
              ? {}
              : { purchaseDate: data.purchaseDate }),
            ...(data.type === undefined ? {} : { type: data.type }),
            ...(data.status === undefined ? {} : { status: data.status }),
            ...(data.referenceNumber === undefined
              ? {}
              : { referenceNumber: data.referenceNumber }),
            ...(data.notes === undefined ? {} : { notes: data.notes }),
            ...(data.payeeId === undefined ? {} : { payeeId }),
            ...(data.freightAmount === undefined
              ? {}
              : { freightAmount: data.freightAmount }),
            ...(data.feeAmount === undefined
              ? {}
              : { feeAmount: data.feeAmount }),
            ...(data.taxAmount === undefined
              ? {}
              : { taxAmount: data.taxAmount }),
            ...(data.discountAmount === undefined
              ? {}
              : { discountAmount: data.discountAmount }),
            ...(data.rebateAmount === undefined
              ? {}
              : { rebateAmount: data.rebateAmount }),
            totalCost,
            marginPercent,
            updatedByActorId: user.staffId,
          },
          include: this.purchaseDetailInclude,
        });

        await this.audit.record(tx, {
          storeId,
          actorId: user.staffId,
          ownerId: user.type === 'owner' ? user.accountId : null,
          action: AuditAction.update,
          entityType: AuditEntityType.purchase,
          entityId: next.id,
          entityName: next.invoiceNumber,
          summary:
            data.status && data.status !== purchase.status
              ? `Changed purchase ${next.invoiceNumber} status to ${this.purchaseStatusLabel(data.status)}`
              : `Updated purchase ${next.invoiceNumber}`,
          before: purchase,
          after: next,
        });

        return next;
      });

      return this.serializePurchaseDetail(updated);
    } catch (error) {
      this.handlePurchaseConflict(error);
      throw error;
    }
  }

  private async ensurePayeeReadAccess(storeId: string, user: AuthTokenPayload) {
    try {
      await this.access.ensureStoreAccess(
        storeId,
        user,
        StorePermissionKey.manage_payees,
      );
    } catch (error) {
      if (!(error instanceof ForbiddenException)) {
        throw error;
      }

      await this.access.ensureStoreAccess(
        storeId,
        user,
        StorePermissionKey.view_purchases,
      );
    }
  }

  private async findPayeeInStoreOrThrow(payeeId: string, storeId: string) {
    const payee = await this.prisma.payee.findFirst({
      where: { id: payeeId, storeId },
    });

    if (!payee) {
      throw new NotFoundException('Payee not found');
    }

    return payee;
  }

  private async ensureActivePayeeInStore(payeeId: string, storeId: string) {
    const payee = await this.prisma.payee.findFirst({
      where: { id: payeeId, storeId },
    });

    if (!payee) {
      throw new BadRequestException(
        'payeeId must belong to the selected store',
      );
    }

    if (!payee.isActive) {
      throw new BadRequestException('Selected payee must be active');
    }

    return payee;
  }

  private parseCreatePayeeBody(body: Record<string, unknown>) {
    return {
      name: this.requiredName(body.name, 'name'),
      accountNumber: this.optionalTrimmedText(
        body.accountNumber,
        'accountNumber',
      ),
      contactName: this.optionalTrimmedText(body.contactName, 'contactName'),
      email: this.optionalTrimmedText(body.email, 'email'),
      phone: this.optionalTrimmedText(body.phone, 'phone'),
      addressLine1: this.optionalTrimmedText(body.addressLine1, 'addressLine1'),
      addressLine2: this.optionalTrimmedText(body.addressLine2, 'addressLine2'),
      city: this.optionalTrimmedText(body.city, 'city'),
      state: this.optionalTrimmedText(body.state, 'state'),
      postalCode: this.optionalTrimmedText(body.postalCode, 'postalCode'),
      notes: this.optionalTrimmedText(body.notes, 'notes', 1000),
      isActive: this.optionalBoolean(body.isActive, 'isActive', true) ?? true,
      payeeType:
        this.optionalEnum(body.payeeType, 'payeeType', PayeeType) ??
        PayeeType.VENDOR,
      allowPosPayments:
        this.optionalBoolean(
          body.allowPosPayments,
          'allowPosPayments',
          false,
        ) ?? false,
    };
  }

  private parseUpdatePayeeBody(body: Record<string, unknown>) {
    const data: Prisma.PayeeUpdateInput = {};

    if (body.name !== undefined) {
      data.name = this.requiredName(body.name, 'name');
    }
    if (body.accountNumber !== undefined) {
      data.accountNumber = this.optionalTrimmedText(
        body.accountNumber,
        'accountNumber',
      );
    }
    if (body.contactName !== undefined) {
      data.contactName = this.optionalTrimmedText(
        body.contactName,
        'contactName',
      );
    }
    if (body.email !== undefined) {
      data.email = this.optionalTrimmedText(body.email, 'email');
    }
    if (body.phone !== undefined) {
      data.phone = this.optionalTrimmedText(body.phone, 'phone');
    }
    if (body.addressLine1 !== undefined) {
      data.addressLine1 = this.optionalTrimmedText(
        body.addressLine1,
        'addressLine1',
      );
    }
    if (body.addressLine2 !== undefined) {
      data.addressLine2 = this.optionalTrimmedText(
        body.addressLine2,
        'addressLine2',
      );
    }
    if (body.city !== undefined) {
      data.city = this.optionalTrimmedText(body.city, 'city');
    }
    if (body.state !== undefined) {
      data.state = this.optionalTrimmedText(body.state, 'state');
    }
    if (body.postalCode !== undefined) {
      data.postalCode = this.optionalTrimmedText(body.postalCode, 'postalCode');
    }
    if (body.notes !== undefined) {
      data.notes = this.optionalTrimmedText(body.notes, 'notes', 1000);
    }
    if (body.isActive !== undefined) {
      data.isActive = this.requiredBoolean(body.isActive, 'isActive');
    }
    if (body.payeeType !== undefined) {
      data.payeeType = this.requiredEnum(
        body.payeeType,
        'payeeType',
        PayeeType,
      );
    }
    if (body.allowPosPayments !== undefined) {
      data.allowPosPayments = this.requiredBoolean(
        body.allowPosPayments,
        'allowPosPayments',
      );
    }

    return data;
  }

  private parseCreatePurchaseBody(body: Record<string, unknown>) {
    return {
      payeeId: this.requiredString(body.payeeId, 'payeeId'),
      invoiceNumber: this.requiredInvoiceNumber(body.invoiceNumber),
      purchaseDate: this.requiredDate(body.purchaseDate, 'purchaseDate'),
      type: this.requiredEnum(body.type, 'type', PurchaseType),
      status: body.status
        ? this.requiredEnum(body.status, 'status', PurchaseStatus)
        : PurchaseStatus.DRAFT,
      referenceNumber: this.optionalTrimmedText(
        body.referenceNumber,
        'referenceNumber',
      ),
      notes: this.optionalTrimmedText(body.notes, 'notes', 2000),
      amounts: {
        freightAmount: this.optionalDecimal(
          body.freightAmount,
          'freightAmount',
        ),
        feeAmount: this.optionalDecimal(body.feeAmount, 'feeAmount'),
        taxAmount: this.optionalDecimal(body.taxAmount, 'taxAmount'),
        discountAmount: this.optionalDecimal(
          body.discountAmount,
          'discountAmount',
        ),
        rebateAmount: this.optionalDecimal(body.rebateAmount, 'rebateAmount'),
      },
      items: this.parsePurchaseItems(body.items),
    };
  }

  private parseUpdatePurchaseBody(body: Record<string, unknown>) {
    return {
      payeeId:
        body.payeeId === undefined
          ? undefined
          : this.requiredString(body.payeeId, 'payeeId'),
      invoiceNumber:
        body.invoiceNumber === undefined
          ? undefined
          : this.requiredInvoiceNumber(body.invoiceNumber),
      purchaseDate:
        body.purchaseDate === undefined
          ? undefined
          : this.requiredDate(body.purchaseDate, 'purchaseDate'),
      type:
        body.type === undefined
          ? undefined
          : this.requiredEnum(body.type, 'type', PurchaseType),
      status:
        body.status === undefined
          ? undefined
          : this.requiredEnum(body.status, 'status', PurchaseStatus),
      referenceNumber:
        body.referenceNumber === undefined
          ? undefined
          : this.optionalTrimmedText(body.referenceNumber, 'referenceNumber'),
      notes:
        body.notes === undefined
          ? undefined
          : this.optionalTrimmedText(body.notes, 'notes', 2000),
      freightAmount:
        body.freightAmount === undefined
          ? undefined
          : this.optionalDecimal(body.freightAmount, 'freightAmount'),
      feeAmount:
        body.feeAmount === undefined
          ? undefined
          : this.optionalDecimal(body.feeAmount, 'feeAmount'),
      taxAmount:
        body.taxAmount === undefined
          ? undefined
          : this.optionalDecimal(body.taxAmount, 'taxAmount'),
      discountAmount:
        body.discountAmount === undefined
          ? undefined
          : this.optionalDecimal(body.discountAmount, 'discountAmount'),
      rebateAmount:
        body.rebateAmount === undefined
          ? undefined
          : this.optionalDecimal(body.rebateAmount, 'rebateAmount'),
    };
  }

  private parsePurchaseItems(value: unknown) {
    if (value === undefined || value === null) {
      return [];
    }

    if (!Array.isArray(value)) {
      throw new BadRequestException('items must be an array');
    }

    return value.map((item, index) => {
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
        unitCost: this.requiredDecimal(
          item.unitCost,
          `items.${index}.unitCost`,
          4,
        ),
        unitRetailSnapshot: this.requiredDecimal(
          item.unitRetailSnapshot,
          `items.${index}.unitRetailSnapshot`,
          2,
        ),
      };
    });
  }

  private async resolvePurchaseItems(
    storeId: string,
    items: Array<{
      productId: string;
      quantity: number;
      unitCost: Prisma.Decimal;
      unitRetailSnapshot: Prisma.Decimal;
    }>,
  ) {
    if (!items.length) {
      return [];
    }

    const products = await this.prisma.product.findMany({
      where: {
        storeId,
        id: { in: items.map((item) => item.productId) },
      },
      select: {
        id: true,
        productNumber: true,
        barcode: true,
        name: true,
      },
    });

    const productMap = new Map(
      products.map((product) => [product.id, product]),
    );

    return items.map((item) => {
      const product = productMap.get(item.productId);

      if (!product) {
        throw new BadRequestException(
          `Product ${item.productId} does not belong to the selected store`,
        );
      }

      const extendedCost = item.unitCost.mul(item.quantity);
      const extendedRetail = item.unitRetailSnapshot.mul(item.quantity);

      return {
        ...item,
        extendedCost,
        extendedRetail,
        productNumberSnapshot: product.productNumber,
        barcodeSnapshot: product.barcode,
        productNameSnapshot: product.name,
      };
    });
  }

  private calculatePurchaseTotals(
    items: Array<{
      quantity: number;
      unitCost: Prisma.Decimal;
      unitRetailSnapshot: Prisma.Decimal;
      extendedCost: Prisma.Decimal;
      extendedRetail: Prisma.Decimal;
    }>,
    amounts: {
      freightAmount: Prisma.Decimal;
      feeAmount: Prisma.Decimal;
      taxAmount: Prisma.Decimal;
      discountAmount: Prisma.Decimal;
      rebateAmount: Prisma.Decimal;
    },
  ) {
    const costSubtotal = items.reduce(
      (sum, item) => sum.plus(item.extendedCost),
      new Prisma.Decimal(0),
    );
    const retailTotal = items.reduce(
      (sum, item) => sum.plus(item.extendedRetail),
      new Prisma.Decimal(0),
    );
    const totalCost = this.calculateTotalCost(
      costSubtotal,
      amounts.freightAmount,
      amounts.feeAmount,
      amounts.taxAmount,
      amounts.discountAmount,
      amounts.rebateAmount,
    );

    return {
      ...amounts,
      costSubtotal,
      retailTotal,
      totalCost,
      marginPercent: this.calculateMarginDecimal(retailTotal, totalCost),
    };
  }

  private calculateTotalCost(
    costSubtotal: Prisma.Decimal,
    freightAmount: Prisma.Decimal,
    feeAmount: Prisma.Decimal,
    taxAmount: Prisma.Decimal,
    discountAmount: Prisma.Decimal,
    rebateAmount: Prisma.Decimal,
  ) {
    return costSubtotal
      .plus(freightAmount)
      .plus(feeAmount)
      .plus(taxAmount)
      .minus(discountAmount)
      .minus(rebateAmount);
  }

  private calculateMarginDecimal(
    retailTotal: Prisma.Decimal,
    totalCost: Prisma.Decimal,
  ) {
    if (retailTotal.equals(0)) {
      return null;
    }

    return retailTotal.minus(totalCost).div(retailTotal).mul(100);
  }

  private calculateMarginPercent(
    retailTotal: Prisma.Decimal,
    totalCost: Prisma.Decimal,
  ) {
    const margin = this.calculateMarginDecimal(retailTotal, totalCost);
    return margin ? margin.toFixed(2) : null;
  }

  private resolveDateRange(query: Record<string, unknown>) {
    const parsedFrom = this.optionalDate(query.dateFrom, 'dateFrom');
    const parsedTo = this.optionalDate(query.dateTo, 'dateTo');
    const now = new Date();
    const dateTo =
      parsedTo ??
      new Date(
        now.getFullYear(),
        now.getMonth(),
        now.getDate(),
        23,
        59,
        59,
        999,
      );
    const dateFrom =
      parsedFrom ??
      new Date(
        dateTo.getFullYear(),
        dateTo.getMonth(),
        dateTo.getDate() - 29,
        0,
        0,
        0,
        0,
      );

    if (dateFrom > dateTo) {
      throw new BadRequestException('dateFrom must be before dateTo');
    }

    return { dateFrom, dateTo };
  }

  private purchaseListOrderBy(
    sort: PurchaseSortField,
    order: 'asc' | 'desc',
  ): Prisma.PurchaseOrderByWithRelationInput[] {
    switch (sort) {
      case 'payee':
        return [{ payee: { name: order } }, { createdAt: 'desc' }];
      case 'invoiceNumber':
        return [{ invoiceNumber: order }, { createdAt: 'desc' }];
      case 'type':
        return [{ type: order }, { createdAt: 'desc' }];
      case 'costSubtotal':
        return [{ costSubtotal: order }, { createdAt: 'desc' }];
      case 'retailTotal':
        return [{ retailTotal: order }, { createdAt: 'desc' }];
      case 'totalCost':
        return [{ totalCost: order }, { createdAt: 'desc' }];
      case 'margin':
        return [{ marginPercent: order }, { createdAt: 'desc' }];
      default:
        return [{ purchaseDate: order }, { createdAt: 'desc' }];
    }
  }

  private serializePayee(payee: Prisma.PayeeGetPayload<Record<string, never>>) {
    return {
      id: payee.id,
      storeId: payee.storeId,
      name: payee.name,
      accountNumber: payee.accountNumber,
      contactName: payee.contactName,
      email: payee.email,
      phone: payee.phone,
      addressLine1: payee.addressLine1,
      addressLine2: payee.addressLine2,
      city: payee.city,
      state: payee.state,
      postalCode: payee.postalCode,
      notes: payee.notes,
      isActive: payee.isActive,
      payeeType: payee.payeeType,
      allowPosPayments: payee.allowPosPayments,
      createdAt: payee.createdAt,
      updatedAt: payee.updatedAt,
    };
  }

  private serializePurchaseListItem(
    purchase: Prisma.PurchaseGetPayload<{
      select: PurchaseService['purchaseListSelect'];
    }>,
  ) {
    return {
      id: purchase.id,
      purchaseNumber: purchase.purchaseNumber,
      invoiceNumber: purchase.invoiceNumber,
      purchaseDate: purchase.purchaseDate,
      type: purchase.type,
      status: purchase.status,
      payee: {
        id: purchase.payee.id,
        name: purchase.payee.name,
      },
      costSubtotal: purchase.costSubtotal.toFixed(2),
      retailTotal: purchase.retailTotal.toFixed(2),
      totalCost: purchase.totalCost.toFixed(2),
      marginPercent:
        purchase.marginPercent === null
          ? null
          : purchase.marginPercent.toFixed(2),
      createdAt: purchase.createdAt,
    };
  }

  private serializePurchaseDetail(
    purchase: Prisma.PurchaseGetPayload<{
      include: PurchaseService['purchaseDetailInclude'];
    }>,
  ) {
    return {
      id: purchase.id,
      purchaseNumber: purchase.purchaseNumber,
      invoiceNumber: purchase.invoiceNumber,
      purchaseDate: purchase.purchaseDate,
      type: purchase.type,
      status: purchase.status,
      referenceNumber: purchase.referenceNumber,
      notes: purchase.notes,
      payee: this.serializePayee(purchase.payee),
      costSubtotal: purchase.costSubtotal.toFixed(2),
      retailTotal: purchase.retailTotal.toFixed(2),
      freightAmount: purchase.freightAmount.toFixed(2),
      feeAmount: purchase.feeAmount.toFixed(2),
      taxAmount: purchase.taxAmount.toFixed(2),
      discountAmount: purchase.discountAmount.toFixed(2),
      rebateAmount: purchase.rebateAmount.toFixed(2),
      totalCost: purchase.totalCost.toFixed(2),
      marginPercent:
        purchase.marginPercent === null
          ? null
          : purchase.marginPercent.toFixed(2),
      lineCount: purchase.items.length,
      totalUnits: purchase.items.reduce((sum, item) => sum + item.quantity, 0),
      items: purchase.items.map((item) => ({
        id: item.id,
        productId: item.productId,
        quantity: item.quantity,
        unitCost: item.unitCost.toFixed(4),
        extendedCost: item.extendedCost.toFixed(2),
        unitRetailSnapshot: item.unitRetailSnapshot.toFixed(2),
        extendedRetail: item.extendedRetail.toFixed(2),
        productNumberSnapshot: item.productNumberSnapshot,
        barcodeSnapshot: item.barcodeSnapshot,
        productNameSnapshot: item.productNameSnapshot,
        product: {
          id: item.product.id,
          productNumber: item.product.productNumber,
          barcode: item.product.barcode,
          name: item.product.name,
        },
      })),
      createdBy:
        purchase.createdByActor === null
          ? null
          : {
              id: purchase.createdByActor.id,
              name: purchase.createdByActor.name,
              email: purchase.createdByActor.email,
              role: purchase.createdByActor.role,
            },
      updatedBy:
        purchase.updatedByActor === null
          ? null
          : {
              id: purchase.updatedByActor.id,
              name: purchase.updatedByActor.name,
              email: purchase.updatedByActor.email,
              role: purchase.updatedByActor.role,
            },
      createdAt: purchase.createdAt,
      updatedAt: purchase.updatedAt,
    };
  }

  private purchaseStatusLabel(status: PurchaseStatus) {
    switch (status) {
      case PurchaseStatus.DRAFT:
        return 'Draft';
      case PurchaseStatus.OPEN:
        return 'Open';
      case PurchaseStatus.VERIFIED:
        return 'Verified';
      case PurchaseStatus.VOIDED:
        return 'Voided';
    }
  }

  private handlePayeeConflict(error: unknown) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002'
    ) {
      throw new ConflictException(
        'A payee with this name already exists for the selected store.',
      );
    }
  }

  private handlePurchaseConflict(error: unknown) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002'
    ) {
      throw new ConflictException(
        'A purchase with this invoice number already exists for this payee.',
      );
    }
  }

  private parsePageLimit(
    query: Record<string, unknown>,
    fallbackLimit: number,
  ) {
    const page = this.optionalPositiveQueryInt(query.page, 'page') ?? 1;
    const limit = Math.min(
      this.optionalPositiveQueryInt(query.limit, 'limit') ?? fallbackLimit,
      100,
    );

    return {
      page,
      limit,
      skip: (page - 1) * limit,
    };
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

  private optionalString(value: unknown, field: string) {
    if (value === undefined || value === null || value === '') {
      return undefined;
    }

    if (typeof value !== 'string') {
      throw new BadRequestException(`${field} must be a string`);
    }

    const trimmed = value.trim();
    return trimmed || undefined;
  }

  private requiredString(value: unknown, field: string) {
    if (typeof value !== 'string' || !value.trim()) {
      throw new BadRequestException(`${field} is required`);
    }

    return value.trim();
  }

  private requiredName(value: unknown, field: string) {
    const name = this.requiredString(value, field).replace(/\s+/g, ' ');
    if (name.length > 120) {
      throw new BadRequestException(`${field} must be 120 characters or fewer`);
    }
    return name;
  }

  private requiredInvoiceNumber(value: unknown) {
    if (typeof value !== 'string') {
      throw new BadRequestException('invoiceNumber is required');
    }

    const trimmed = value.trim();
    if (!trimmed) {
      throw new BadRequestException('invoiceNumber is required');
    }
    if (trimmed.length > 100) {
      throw new BadRequestException(
        'invoiceNumber must be 100 characters or fewer',
      );
    }
    if (
      [...trimmed].some((character) => {
        const code = character.charCodeAt(0);
        return code < 32 || code === 127;
      })
    ) {
      throw new BadRequestException(
        'invoiceNumber contains unsupported control characters',
      );
    }

    return trimmed;
  }

  private optionalTrimmedText(value: unknown, field: string, maxLength = 255) {
    if (value === undefined || value === null || value === '') {
      return null;
    }

    if (typeof value !== 'string') {
      throw new BadRequestException(`${field} must be a string`);
    }

    const trimmed = value.trim();
    if (!trimmed) {
      return null;
    }
    if (trimmed.length > maxLength) {
      throw new BadRequestException(
        `${field} must be ${maxLength} characters or fewer`,
      );
    }

    return trimmed;
  }

  private optionalBoolean(value: unknown, field: string, fallback?: boolean) {
    if (value === undefined || value === null) {
      return fallback;
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

  private requiredDate(value: unknown, field: string) {
    if (typeof value !== 'string' && !(value instanceof Date)) {
      throw new BadRequestException(`${field} is required`);
    }

    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) {
      throw new BadRequestException(`${field} must be a valid date`);
    }

    return date;
  }

  private optionalDate(value: unknown, field: string) {
    if (value === undefined || value === null || value === '') {
      return undefined;
    }

    return this.requiredDate(value, field);
  }

  private requiredPositiveInt(value: unknown, field: string) {
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

  private optionalPositiveQueryInt(value: unknown, field: string) {
    if (value === undefined || value === null || value === '') {
      return undefined;
    }

    return this.requiredPositiveInt(value, field);
  }

  private requiredDecimal(value: unknown, field: string, maxScale: number) {
    if (
      typeof value !== 'number' &&
      typeof value !== 'string' &&
      !(value instanceof Prisma.Decimal)
    ) {
      throw new BadRequestException(`${field} must be a number`);
    }

    const decimal =
      value instanceof Prisma.Decimal ? value : new Prisma.Decimal(value);
    if (decimal.lessThan(0)) {
      throw new BadRequestException(`${field} must be zero or greater`);
    }

    const decimalPart = decimal.toString().split('.')[1] ?? '';
    if (decimalPart.length > maxScale) {
      throw new BadRequestException(
        `${field} must have ${maxScale} or fewer decimal places`,
      );
    }

    return decimal;
  }

  private optionalDecimal(value: unknown, field: string) {
    if (value === undefined || value === null || value === '') {
      return new Prisma.Decimal(0);
    }

    return this.requiredDecimal(value, field, 2);
  }

  private isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }

  private isPositiveIntegerText(value: string) {
    return /^\d+$/.test(value);
  }

  private readonly purchaseListSelect = {
    id: true,
    purchaseNumber: true,
    invoiceNumber: true,
    purchaseDate: true,
    type: true,
    status: true,
    costSubtotal: true,
    retailTotal: true,
    totalCost: true,
    marginPercent: true,
    createdAt: true,
    payee: {
      select: {
        id: true,
        name: true,
      },
    },
  } satisfies Prisma.PurchaseSelect;

  private readonly purchaseDetailInclude = {
    payee: true,
    items: {
      include: {
        product: {
          select: {
            id: true,
            productNumber: true,
            barcode: true,
            name: true,
          },
        },
      },
      orderBy: [{ createdAt: 'asc' }],
    },
    createdByActor: {
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
      },
    },
    updatedByActor: {
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
      },
    },
  } satisfies Prisma.PurchaseInclude;
}
