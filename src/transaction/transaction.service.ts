import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  InventoryActionType,
  PaymentMethod,
  Prisma,
  TaxStyle,
} from '@prisma/client';
import { AuthTokenPayload } from '../auth/strategies/jwt.strategy';
import { PosAccessService } from '../common/pos-access.service';
import { PrismaService } from '../prisma.service';

@Injectable()
export class TransactionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: PosAccessService,
  ) {}

  async validateCart(body: Record<string, unknown>, user: AuthTokenPayload) {
    const dto = this.parseCartBody(body);
    await this.access.ensureStoreAccess(dto.storeId, user, 'view_store');

    const validated = await this.validateCartForStore(dto, this.prisma);

    return this.toValidatedCartResponse(validated);
  }

  async checkout(body: Record<string, unknown>, user: AuthTokenPayload) {
    const dto = this.parseCheckoutBody(body);
    await this.access.ensureStoreAccess(dto.storeId, user, 'view_store');

    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        return await this.prisma.$transaction(async (tx) => {
          const validated = await this.validateCartForStore(dto, tx);
          this.validatePaymentMethodForCart(dto.paymentMethod, validated);
          const customer = dto.customerId
            ? await this.validateCustomerForCheckout(
                tx,
                dto.customerId,
                dto.storeId,
              )
            : null;
          const rewardPointsEarned = customer
            ? validated.total
                .toDecimalPlaces(0, Prisma.Decimal.ROUND_FLOOR)
                .toNumber()
            : 0;
          const receiptNumber = await this.generateReceiptNumber(tx);

          const transaction = await tx.transaction.create({
            data: {
              storeId: dto.storeId,
              staffId: user.staffId,
              customerId: customer?.id,
              subtotal: validated.subtotal,
              discountTotal: validated.discountTotal,
              taxTotal: validated.taxTotal,
              total: validated.total,
              paymentMethod: dto.paymentMethod,
              receiptNumber,
              notes: dto.notes,
              items: {
                create: validated.items.map((item) => ({
                  productId: item.productId,
                  nameSnapshot: item.name,
                  barcodeSnapshot: item.barcode,
                  quantity: item.quantity,
                  unitPrice: item.unitPrice,
                  lineSubtotal: item.lineSubtotal,
                  discountAmount: item.discountAmount,
                  taxAmount: item.taxAmount,
                  lineTotal: item.lineTotal,
                  taxStyle: item.taxStyle,
                })),
              },
            },
            include: this.fullTransactionInclude,
          });

          const inventoryBalances = new Map(
            validated.items.map((item) => [
              item.productId,
              item.currentQuantity,
            ]),
          );

          for (const item of validated.items) {
            if (!item.trackInventory) {
              continue;
            }

            const quantityBefore =
              inventoryBalances.get(item.productId) ?? item.currentQuantity;
            const quantityAfter = quantityBefore - item.quantity;

            const updateResult = item.allowNegativeInventory
              ? await tx.product.updateMany({
                  where: { id: item.productId },
                  data: { currentQuantity: { decrement: item.quantity } },
                })
              : await tx.product.updateMany({
                  where: {
                    id: item.productId,
                    currentQuantity: { gte: item.quantity },
                  },
                  data: { currentQuantity: { decrement: item.quantity } },
                });

            if (updateResult.count !== 1) {
              throw new BadRequestException(
                `${item.name} does not have enough inventory`,
              );
            }

            inventoryBalances.set(item.productId, quantityAfter);

            await tx.inventoryLog.create({
              data: {
                storeId: dto.storeId,
                productId: item.productId,
                performedByStaffId: user.staffId,
                actionType: InventoryActionType.sale,
                quantityBefore,
                quantityChanged: -item.quantity,
                quantityAfter,
                reason: 'sale',
                referenceType: 'transaction',
                referenceId: transaction.id,
              },
            });
          }

          if (customer) {
            await tx.customerPurchaseHistory.create({
              data: {
                customerId: customer.id,
                storeId: dto.storeId,
                transactionId: transaction.id,
                totalSpend: validated.total,
              },
            });

            await tx.customer.update({
              where: { id: customer.id },
              data: { rewardPoints: { increment: rewardPointsEarned } },
            });
          }

          const receiptData = this.buildReceiptData(
            transaction,
            receiptNumber,
            rewardPointsEarned,
          );
          const receipt = await tx.receipt.create({
            data: {
              transactionId: transaction.id,
              receiptNumber,
              receiptData,
            },
          });

          return {
            transaction: this.toTransactionResponse(transaction),
            receipt: {
              id: receipt.id,
              transactionId: receipt.transactionId,
              receiptNumber: receipt.receiptNumber,
              receiptData: receipt.receiptData,
              createdAt: receipt.createdAt,
            },
          };
        });
      } catch (error) {
        if (this.isReceiptNumberConflict(error) && attempt < 4) {
          continue;
        }

        throw error;
      }
    }

    throw new ConflictException('Unable to generate receipt number');
  }

  async listByStore(
    storeId: string,
    user: AuthTokenPayload,
    query: Record<string, unknown> = {},
  ) {
    await this.access.ensureStoreAccess(storeId, user, 'view_store');
    const pagination = this.parsePagination(query);

    const transactions = await this.prisma.transaction.findMany({
      where: { storeId },
      orderBy: { createdAt: 'desc' },
      skip: pagination.skip,
      take: pagination.take,
      include: {
        _count: { select: { items: true } },
        customer: {
          select: {
            id: true,
            customerNumber: true,
            firstName: true,
            lastName: true,
            phone: true,
          },
        },
        staff: {
          select: {
            id: true,
            name: true,
            role: true,
          },
        },
      },
    });

    return transactions.map((transaction) => ({
      id: transaction.id,
      storeId: transaction.storeId,
      customerId: transaction.customerId,
      staffId: transaction.staffId,
      receiptNumber: transaction.receiptNumber,
      paymentMethod: transaction.paymentMethod,
      paymentStatus: transaction.paymentStatus,
      transactionStatus: transaction.transactionStatus,
      subtotal: this.moneyToString(transaction.subtotal),
      discountTotal: this.moneyToString(transaction.discountTotal),
      taxTotal: this.moneyToString(transaction.taxTotal),
      total: this.moneyToString(transaction.total),
      notes: transaction.notes,
      createdAt: transaction.createdAt,
      updatedAt: transaction.updatedAt,
      itemCount: transaction._count.items,
      customer: transaction.customer,
      staff: transaction.staff,
    }));
  }

  async findOne(transactionId: string, user: AuthTokenPayload) {
    const transaction = await this.findTransactionOrThrow(transactionId);
    await this.access.ensureStoreAccess(
      transaction.storeId,
      user,
      'view_store',
    );

    return this.toTransactionResponse(transaction);
  }

  async findReceipt(transactionId: string, user: AuthTokenPayload) {
    const receipt = await this.prisma.receipt.findUnique({
      where: { transactionId },
      include: {
        transaction: {
          select: { storeId: true },
        },
      },
    });

    if (!receipt) {
      throw new NotFoundException('Receipt not found');
    }

    await this.access.ensureStoreAccess(
      receipt.transaction.storeId,
      user,
      'view_store',
    );

    return receipt.receiptData;
  }

  async findReceiptByNumber(receiptNumber: string, user: AuthTokenPayload) {
    const receipt = await this.prisma.receipt.findUnique({
      where: {
        receiptNumber: this.requiredString(receiptNumber, 'receiptNumber'),
      },
      include: {
        transaction: {
          select: { storeId: true },
        },
      },
    });

    if (!receipt) {
      throw new NotFoundException('Receipt not found');
    }

    await this.access.ensureStoreAccess(
      receipt.transaction.storeId,
      user,
      'view_store',
    );

    return receipt.receiptData;
  }

  private async validateCartForStore(
    dto: CartDto,
    tx: Prisma.TransactionClient | PrismaService,
  ): Promise<ValidatedCart> {
    if (dto.customerId) {
      await this.validateCustomerForCart(tx, dto.customerId, dto.storeId);
    }

    const items: ValidatedCartItem[] = [];
    const requestedQuantities = new Map<string, number>();
    let subtotal = this.money(0);
    let discountTotal = this.money(0);
    let taxTotal = this.money(0);

    for (const [index, item] of dto.items.entries()) {
      const product = await tx.product.findFirst({
        where: { id: item.productId, storeId: dto.storeId, isActive: true },
        include: { tax: true },
      });

      if (!product) {
        throw new NotFoundException(`items.${index}.productId not found`);
      }

      const requestedQuantity =
        (requestedQuantities.get(product.id) ?? 0) + item.quantity;
      requestedQuantities.set(product.id, requestedQuantity);

      if (
        product.trackInventory &&
        !product.allowNegativeInventory &&
        requestedQuantity > product.currentQuantity
      ) {
        throw new BadRequestException(
          `${product.name} does not have enough inventory`,
        );
      }

      const unitPrice = this.money(product.unitRetail);
      const lineSubtotal = this.roundMoney(unitPrice.mul(item.quantity));
      const discountAmount = this.money(item.discountAmount ?? 0);

      if (discountAmount.greaterThan(lineSubtotal)) {
        throw new BadRequestException(
          `items.${index}.discountAmount cannot exceed line subtotal`,
        );
      }

      const taxableAmount =
        product.taxStyle === TaxStyle.pre_discount
          ? lineSubtotal
          : lineSubtotal.minus(discountAmount);
      const taxAmount = this.roundMoney(taxableAmount.mul(product.tax.rate));
      const lineTotal = this.roundMoney(
        lineSubtotal.minus(discountAmount).plus(taxAmount),
      );

      subtotal = subtotal.plus(lineSubtotal);
      discountTotal = discountTotal.plus(discountAmount);
      taxTotal = taxTotal.plus(taxAmount);

      items.push({
        productId: product.id,
        name: product.name,
        barcode: product.barcode,
        quantity: item.quantity,
        unitPrice,
        lineSubtotal,
        discountAmount,
        taxAmount,
        lineTotal,
        taxStyle: product.taxStyle,
        allowEbt: product.allowEbt,
        trackInventory: product.trackInventory,
        allowNegativeInventory: product.allowNegativeInventory,
        currentQuantity: product.currentQuantity,
      });
    }

    subtotal = this.roundMoney(subtotal);
    discountTotal = this.roundMoney(discountTotal);
    taxTotal = this.roundMoney(taxTotal);

    return {
      valid: true,
      items,
      subtotal,
      discountTotal,
      taxTotal,
      total: this.roundMoney(subtotal.minus(discountTotal).plus(taxTotal)),
    };
  }

  private async validateCustomerForCart(
    tx: Prisma.TransactionClient | PrismaService,
    customerId: string,
    storeId: string,
  ) {
    const customer = await tx.customer.findUnique({
      where: { id: customerId },
      select: {
        id: true,
        stores: {
          where: { storeId },
          select: { id: true },
        },
      },
    });

    if (!customer) {
      throw new NotFoundException('Customer not found');
    }
  }

  private async validateCustomerForCheckout(
    tx: Prisma.TransactionClient,
    customerId: string,
    storeId: string,
  ) {
    const customer = await tx.customer.findUnique({
      where: { id: customerId },
      include: {
        stores: {
          where: { storeId },
          select: { id: true },
        },
      },
    });

    if (!customer) {
      throw new NotFoundException('Customer not found');
    }

    if (!customer.stores.length) {
      await tx.customerStore.create({
        data: {
          customerId,
          storeId,
        },
      });
    }

    return customer;
  }

  private async findTransactionOrThrow(transactionId: string) {
    const transaction = await this.prisma.transaction.findUnique({
      where: { id: transactionId },
      include: this.fullTransactionInclude,
    });

    if (!transaction) {
      throw new NotFoundException('Transaction not found');
    }

    return transaction;
  }

  private async generateReceiptNumber(tx: Prisma.TransactionClient) {
    const now = new Date();
    const startOfDay = new Date(now);
    startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date(now);
    endOfDay.setHours(23, 59, 59, 999);
    const yyyymmdd = [
      now.getFullYear(),
      String(now.getMonth() + 1).padStart(2, '0'),
      String(now.getDate()).padStart(2, '0'),
    ].join('');
    const count = await tx.transaction.count({
      where: {
        createdAt: {
          gte: startOfDay,
          lte: endOfDay,
        },
      },
    });

    return `PD-${yyyymmdd}-${String(count + 1).padStart(6, '0')}`;
  }

  private buildReceiptData(
    transaction: TransactionWithRelations,
    receiptNumber: string,
    rewardPointsEarned: number,
  ): Prisma.InputJsonObject {
    return {
      receiptNumber,
      store: {
        id: transaction.store.id,
        name: transaction.store.name,
        address: transaction.store.address,
      },
      transaction: {
        id: transaction.id,
        createdAt: transaction.createdAt.toISOString(),
        paymentMethod: transaction.paymentMethod,
        paymentStatus: transaction.paymentStatus,
        transactionStatus: transaction.transactionStatus,
      },
      cashier: {
        id: transaction.staff.id,
        name: transaction.staff.name,
        role: transaction.staff.role,
      },
      staff: {
        id: transaction.staff.id,
        name: transaction.staff.name,
        role: transaction.staff.role,
      },
      customer: transaction.customer
        ? {
            id: transaction.customer.id,
            customerNumber: transaction.customer.customerNumber,
            firstName: transaction.customer.firstName,
            lastName: transaction.customer.lastName,
            phone: transaction.customer.phone,
          }
        : null,
      items: transaction.items.map((item) => ({
        productId: item.productId,
        name: item.nameSnapshot,
        barcode: item.barcodeSnapshot,
        quantity: item.quantity,
        unitPrice: this.moneyToString(item.unitPrice),
        lineSubtotal: this.moneyToString(item.lineSubtotal),
        discountAmount: this.moneyToString(item.discountAmount),
        taxAmount: this.moneyToString(item.taxAmount),
        lineTotal: this.moneyToString(item.lineTotal),
      })),
      subtotal: this.moneyToString(transaction.subtotal),
      discountTotal: this.moneyToString(transaction.discountTotal),
      taxTotal: this.moneyToString(transaction.taxTotal),
      total: this.moneyToString(transaction.total),
      rewardPointsEarned: transaction.customer ? rewardPointsEarned : null,
    };
  }

  private toValidatedCartResponse(cart: ValidatedCart) {
    return {
      valid: cart.valid,
      items: cart.items.map((item) => ({
        productId: item.productId,
        name: item.name,
        barcode: item.barcode,
        quantity: item.quantity,
        unitPrice: this.moneyToString(item.unitPrice),
        lineSubtotal: this.moneyToString(item.lineSubtotal),
        discountAmount: this.moneyToString(item.discountAmount),
        taxAmount: this.moneyToString(item.taxAmount),
        lineTotal: this.moneyToString(item.lineTotal),
        taxStyle: item.taxStyle,
      })),
      subtotal: this.moneyToString(cart.subtotal),
      discountTotal: this.moneyToString(cart.discountTotal),
      taxTotal: this.moneyToString(cart.taxTotal),
      total: this.moneyToString(cart.total),
    };
  }

  private toTransactionResponse(transaction: TransactionWithRelations) {
    return {
      id: transaction.id,
      storeId: transaction.storeId,
      staffId: transaction.staffId,
      customerId: transaction.customerId,
      subtotal: this.moneyToString(transaction.subtotal),
      discountTotal: this.moneyToString(transaction.discountTotal),
      taxTotal: this.moneyToString(transaction.taxTotal),
      total: this.moneyToString(transaction.total),
      paymentMethod: transaction.paymentMethod,
      paymentStatus: transaction.paymentStatus,
      transactionStatus: transaction.transactionStatus,
      receiptNumber: transaction.receiptNumber,
      notes: transaction.notes,
      createdAt: transaction.createdAt,
      updatedAt: transaction.updatedAt,
      store: transaction.store,
      staff: transaction.staff,
      customer: transaction.customer,
      items: transaction.items.map((item) => ({
        id: item.id,
        transactionId: item.transactionId,
        productId: item.productId,
        nameSnapshot: item.nameSnapshot,
        barcodeSnapshot: item.barcodeSnapshot,
        quantity: item.quantity,
        unitPrice: this.moneyToString(item.unitPrice),
        lineSubtotal: this.moneyToString(item.lineSubtotal),
        discountAmount: this.moneyToString(item.discountAmount),
        taxAmount: this.moneyToString(item.taxAmount),
        lineTotal: this.moneyToString(item.lineTotal),
        taxStyle: item.taxStyle,
        createdAt: item.createdAt,
      })),
    };
  }

  private parseCartBody(body: Record<string, unknown>): CartDto {
    const items = body.items;

    if (!Array.isArray(items) || items.length === 0) {
      throw new BadRequestException('items must contain at least one item');
    }

    if (items.length > 200) {
      throw new BadRequestException('items cannot contain more than 200 items');
    }

    return {
      storeId: this.requiredString(body.storeId, 'storeId'),
      customerId:
        body.customerId === undefined
          ? undefined
          : (this.optionalString(body.customerId, 'customerId') ?? undefined),
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
          discountAmount:
            item.discountAmount === undefined
              ? undefined
              : this.requiredMoney(
                  item.discountAmount,
                  `items.${index}.discountAmount`,
                ),
        };
      }),
    };
  }

  private parseCheckoutBody(body: Record<string, unknown>): CheckoutDto {
    const paymentMethod = this.requiredEnum(
      body.paymentMethod,
      'paymentMethod',
      PaymentMethod,
    );

    if (paymentMethod === PaymentMethod.split) {
      throw new BadRequestException('split payment is not supported yet');
    }

    const notes =
      body.notes === undefined
        ? undefined
        : (this.optionalString(body.notes, 'notes') ?? undefined);

    if (notes && notes.length > 1000) {
      throw new BadRequestException('notes cannot exceed 1000 characters');
    }

    return {
      ...this.parseCartBody(body),
      paymentMethod,
      notes,
    };
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

  private optionalString(value: unknown, field: string) {
    if (value === undefined || value === null) {
      return null;
    }

    if (typeof value !== 'string') {
      throw new BadRequestException(`${field} must be a string`);
    }

    return value.trim() || null;
  }

  private requiredPositiveInt(value: unknown, field: string) {
    if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
      throw new BadRequestException(`${field} must be a positive integer`);
    }

    if (value > 2_147_483_647) {
      throw new BadRequestException(`${field} exceeds the maximum integer`);
    }

    return value;
  }

  private requiredMoney(value: unknown, field: string) {
    if (typeof value !== 'number' && typeof value !== 'string') {
      throw new BadRequestException(`${field} must be a number`);
    }

    let decimal: Prisma.Decimal;

    try {
      decimal = this.money(value);
    } catch {
      throw new BadRequestException(`${field} must be a valid money amount`);
    }

    if (decimal.isNegative()) {
      throw new BadRequestException(`${field} must be zero or greater`);
    }

    if (decimal.greaterThan(99_999_999_999.99)) {
      throw new BadRequestException(`${field} exceeds the maximum amount`);
    }

    return decimal;
  }

  private validatePaymentMethodForCart(
    paymentMethod: PaymentMethod,
    cart: ValidatedCart,
  ) {
    if (
      paymentMethod === PaymentMethod.ebt &&
      cart.items.some((item) => !item.allowEbt)
    ) {
      throw new BadRequestException(
        'ebt payment cannot be used for non-EBT items',
      );
    }
  }

  private parsePagination(query: Record<string, unknown>) {
    const page = this.optionalPositiveQueryInt(query.page, 'page') ?? 1;
    const take = this.optionalPositiveQueryInt(query.take, 'take') ?? 50;

    return {
      skip: (page - 1) * take,
      take: Math.min(take, 100),
    };
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

  private money(value: Prisma.Decimal.Value) {
    return this.roundMoney(new Prisma.Decimal(value));
  }

  private roundMoney(value: Prisma.Decimal) {
    return value.toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
  }

  private moneyToString(value: Prisma.Decimal) {
    return value.toFixed(2);
  }

  private isReceiptNumberConflict(error: unknown) {
    return (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002' &&
      Array.isArray(error.meta?.target) &&
      error.meta.target.includes('receiptNumber')
    );
  }

  private readonly fullTransactionInclude = {
    store: true,
    staff: {
      select: {
        id: true,
        name: true,
        role: true,
      },
    },
    customer: {
      select: {
        id: true,
        customerNumber: true,
        firstName: true,
        lastName: true,
        phone: true,
      },
    },
    items: {
      orderBy: { createdAt: 'asc' },
    },
  } satisfies Prisma.TransactionInclude;
}

type CartDto = {
  storeId: string;
  customerId?: string;
  items: {
    productId: string;
    quantity: number;
    discountAmount?: Prisma.Decimal;
  }[];
};

type CheckoutDto = CartDto & {
  paymentMethod: PaymentMethod;
  notes?: string;
};

type ValidatedCartItem = {
  productId: string;
  name: string;
  barcode: string;
  quantity: number;
  unitPrice: Prisma.Decimal;
  lineSubtotal: Prisma.Decimal;
  discountAmount: Prisma.Decimal;
  taxAmount: Prisma.Decimal;
  lineTotal: Prisma.Decimal;
  taxStyle: TaxStyle;
  allowEbt: boolean;
  trackInventory: boolean;
  allowNegativeInventory: boolean;
  currentQuantity: number;
};

type ValidatedCart = {
  valid: true;
  items: ValidatedCartItem[];
  subtotal: Prisma.Decimal;
  discountTotal: Prisma.Decimal;
  taxTotal: Prisma.Decimal;
  total: Prisma.Decimal;
};

type TransactionWithRelations = Prisma.TransactionGetPayload<{
  include: {
    store: true;
    staff: {
      select: {
        id: true;
        name: true;
        role: true;
      };
    };
    customer: {
      select: {
        id: true;
        customerNumber: true;
        firstName: true;
        lastName: true;
        phone: true;
      };
    };
    items: {
      orderBy: { createdAt: 'asc' };
    };
  };
}>;
