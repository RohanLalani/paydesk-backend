import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  InventoryActionType,
  CartStatus,
  PaymentMethod,
  PaymentStatus,
  Prisma,
  TaxStyle,
  TransactionStatus,
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
    const dto = this.parseCartCheckoutBody(body);

    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        return await this.prisma.$transaction(async (tx) => {
          await this.lockCart(tx, dto.cartId);

          const cart = await this.getCheckoutCart(tx, dto.cartId);

          await this.access.ensureStoreAccess(cart.storeId, user, 'view_store');

          const validated = await this.validateCheckoutCart(tx, cart);
          this.validatePaymentMethodForCart(dto.paymentMethod, validated);
          const receiptNumber = await this.generateReceiptNumber(tx);

          const transaction = await tx.transaction.create({
            data: {
              storeId: cart.storeId,
              staffId: user.staffId,
              customerId: cart.customerId,
              subtotal: validated.subtotal,
              discountTotal: validated.discountTotal,
              taxTotal: validated.taxTotal,
              total: validated.total,
              paymentMethod: dto.paymentMethod,
              paymentStatus: PaymentStatus.paid,
              transactionStatus: TransactionStatus.completed,
              receiptNumber,
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

          for (const item of validated.items) {
            if (!item.trackInventory) {
              continue;
            }

            const quantityBefore = item.currentQuantity;
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

            await tx.inventoryLog.create({
              data: {
                storeId: cart.storeId,
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

          if (cart.customerId) {
            await tx.customerPurchaseHistory.create({
              data: {
                customerId: cart.customerId,
                storeId: cart.storeId,
                transactionId: transaction.id,
                totalSpend: validated.total,
              },
            });

            await this.recalculateCustomerTierForStore(
              tx,
              cart.customerId,
              cart.storeId,
            );
          }

          const receiptData = this.buildCheckoutReceiptData(
            transaction,
            validated,
          );
          const receipt = await tx.receipt.create({
            data: {
              transactionId: transaction.id,
              receiptNumber,
              receiptData,
            },
          });

          await tx.cart.update({
            where: { id: cart.id },
            data: { status: CartStatus.completed },
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

  async findReceiptByNumberWithoutUser(receiptNumber: string) {
    const receipt = await this.prisma.receipt.findUnique({
      where: {
        receiptNumber: this.requiredString(receiptNumber, 'receiptNumber'),
      },
    });

    if (!receipt) {
      throw new NotFoundException('Receipt not found');
    }

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

  private async getCheckoutCart(tx: Prisma.TransactionClient, cartId: string) {
    const cart = await tx.cart.findUnique({
      where: { id: this.requiredString(cartId, 'cartId') },
      include: this.checkoutCartInclude,
    });

    if (!cart) {
      throw new NotFoundException('Cart not found');
    }

    if (cart.status !== CartStatus.ready_for_payment) {
      throw new BadRequestException('Cart is not ready for payment');
    }

    if (!cart.items.length) {
      throw new BadRequestException('Cart is empty');
    }

    return cart;
  }

  private async validateCheckoutCart(
    tx: Prisma.TransactionClient,
    cart: CheckoutCart,
  ): Promise<ValidatedCart> {
    const itemCalculations = cart.items.map((item) => {
      const originalSubtotal = this.money(item.originalUnitPrice).mul(
        item.quantity,
      );
      const lineSubtotal = this.money(item.unitPrice).mul(item.quantity);
      const itemDiscount = Prisma.Decimal.max(
        originalSubtotal.minus(lineSubtotal),
        0,
      );

      return {
        item,
        originalSubtotal: this.roundMoney(originalSubtotal),
        lineSubtotal: this.roundMoney(lineSubtotal),
        itemDiscount: this.roundMoney(itemDiscount),
        loyaltyDiscount: this.money(0),
      };
    });
    const subtotal = this.roundMoney(
      itemCalculations.reduce(
        (total, item) => total.plus(item.lineSubtotal),
        this.money(0),
      ),
    );
    const itemDiscountTotal = this.roundMoney(
      itemCalculations.reduce(
        (total, item) => total.plus(item.itemDiscount),
        this.money(0),
      ),
    );
    const loyaltyDiscountTotal = this.applyCartLoyaltyDiscounts(
      cart,
      itemCalculations,
      subtotal,
    );
    let taxTotal = this.money(0);
    const checkoutItems: ValidatedCartItem[] = [];

    for (const calculation of itemCalculations) {
      const lockedProduct = await this.getLockedProductForCheckout(
        tx,
        calculation.item.productId,
      );

      if (
        lockedProduct.trackInventory &&
        !lockedProduct.allowNegativeInventory &&
        calculation.item.quantity > lockedProduct.currentQuantity
      ) {
        throw new BadRequestException(
          `${lockedProduct.name} does not have enough inventory`,
        );
      }

      const taxableAmount =
        lockedProduct.taxStyle === TaxStyle.pre_discount
          ? calculation.lineSubtotal
          : Prisma.Decimal.max(
              calculation.lineSubtotal.minus(calculation.loyaltyDiscount),
              0,
            );
      const taxAmount = this.roundMoney(
        taxableAmount.mul(lockedProduct.tax.rate),
      );
      const discountAmount = this.roundMoney(
        calculation.itemDiscount.plus(calculation.loyaltyDiscount),
      );
      const lineTotal = this.roundMoney(
        Prisma.Decimal.max(
          calculation.lineSubtotal
            .minus(calculation.loyaltyDiscount)
            .plus(taxAmount),
          0,
        ),
      );

      taxTotal = taxTotal.plus(taxAmount);

      checkoutItems.push({
        productId: lockedProduct.id,
        name: lockedProduct.name,
        barcode: lockedProduct.barcode,
        quantity: calculation.item.quantity,
        unitPrice: this.money(calculation.item.unitPrice),
        lineSubtotal: calculation.lineSubtotal,
        discountAmount,
        taxAmount,
        lineTotal,
        taxStyle: lockedProduct.taxStyle,
        allowEbt: lockedProduct.allowEbt,
        trackInventory: lockedProduct.trackInventory,
        allowNegativeInventory: lockedProduct.allowNegativeInventory,
        currentQuantity: lockedProduct.currentQuantity,
      });
    }

    taxTotal = this.roundMoney(taxTotal);

    return {
      valid: true,
      items: checkoutItems,
      subtotal,
      discountTotal: this.roundMoney(
        itemDiscountTotal.plus(loyaltyDiscountTotal),
      ),
      taxTotal,
      total: this.roundMoney(
        Prisma.Decimal.max(
          subtotal.minus(loyaltyDiscountTotal).plus(taxTotal),
          0,
        ),
      ),
    };
  }

  private async getLockedProductForCheckout(
    tx: Prisma.TransactionClient,
    productId: string,
  ) {
    await tx.$executeRaw`SELECT id FROM "Product" WHERE id = ${productId} FOR UPDATE`;

    const product = await tx.product.findUnique({
      where: { id: productId },
      include: { tax: true },
    });

    if (!product?.isActive) {
      throw new NotFoundException('Product not found');
    }

    return product;
  }

  private applyCartLoyaltyDiscounts(
    cart: CheckoutCart,
    itemCalculations: CheckoutItemCalculation[],
    subtotal: Prisma.Decimal,
  ) {
    const customerStore = cart.customer?.stores.find(
      (store) => store.storeId === cart.storeId,
    );
    const tier = customerStore?.currentTier;

    if (!tier?.isActive) {
      return this.money(0);
    }

    const discountValue = this.money(tier.discountValue);
    let loyaltyDiscountTotal = this.money(0);

    if (tier.discountModel === 'ORDER_PERCENTAGE') {
      loyaltyDiscountTotal = subtotal.mul(discountValue).div(100);
      this.distributeCartLoyaltyDiscount(
        itemCalculations,
        loyaltyDiscountTotal,
      );
    }

    if (tier.discountModel === 'ORDER_FLAT_RATE') {
      loyaltyDiscountTotal = Prisma.Decimal.min(discountValue, subtotal);
      this.distributeCartLoyaltyDiscount(
        itemCalculations,
        loyaltyDiscountTotal,
      );
    }

    if (tier.discountModel === 'ITEM_PERCENTAGE') {
      for (const item of itemCalculations) {
        item.loyaltyDiscount = Prisma.Decimal.min(
          item.lineSubtotal.mul(discountValue).div(100),
          item.lineSubtotal,
        );
        loyaltyDiscountTotal = loyaltyDiscountTotal.plus(item.loyaltyDiscount);
      }
    }

    if (tier.discountModel === 'ITEM_FLAT_RATE') {
      for (const item of itemCalculations) {
        item.loyaltyDiscount = Prisma.Decimal.min(
          discountValue.mul(item.item.quantity),
          item.lineSubtotal,
        );
        loyaltyDiscountTotal = loyaltyDiscountTotal.plus(item.loyaltyDiscount);
      }
    }

    for (const item of itemCalculations) {
      item.loyaltyDiscount = this.roundMoney(item.loyaltyDiscount);
    }

    return this.roundMoney(Prisma.Decimal.min(loyaltyDiscountTotal, subtotal));
  }

  private distributeCartLoyaltyDiscount(
    items: CheckoutItemCalculation[],
    discount: Prisma.Decimal,
  ) {
    const subtotal = items.reduce(
      (total, item) => total.plus(item.lineSubtotal),
      this.money(0),
    );

    if (subtotal.isZero()) {
      return;
    }

    let remaining = Prisma.Decimal.min(discount, subtotal);

    items.forEach((item, index) => {
      if (index === items.length - 1) {
        item.loyaltyDiscount = Prisma.Decimal.min(remaining, item.lineSubtotal);
        return;
      }

      item.loyaltyDiscount = Prisma.Decimal.min(
        this.roundMoney(discount.mul(item.lineSubtotal).div(subtotal)),
        item.lineSubtotal,
      );
      remaining = remaining.minus(item.loyaltyDiscount);
    });
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

  private async recalculateCustomerTierForStore(
    tx: Prisma.TransactionClient,
    customerId: string,
    storeId: string,
  ) {
    const store = await tx.store.findUnique({
      where: { id: storeId },
      select: { ownerId: true },
    });

    if (!store) {
      throw new NotFoundException('Store not found');
    }

    const customerStore = await tx.customerStore.findUnique({
      where: {
        customerId_storeId: {
          customerId,
          storeId,
        },
      },
    });

    if (!customerStore) {
      throw new NotFoundException('Customer not found for store');
    }

    const since = this.getPurchaseHistoryCutoff();
    const [storeSpendResult, ownerSpendResult] = await Promise.all([
      tx.customerPurchaseHistory.aggregate({
        where: {
          customerId,
          storeId,
          purchasedAt: { gte: since },
        },
        _sum: { totalSpend: true },
      }),
      tx.customerPurchaseHistory.aggregate({
        where: {
          customerId,
          store: { ownerId: store.ownerId },
          purchasedAt: { gte: since },
        },
        _sum: { totalSpend: true },
      }),
    ]);
    const storeSpend =
      storeSpendResult._sum.totalSpend ?? new Prisma.Decimal(0);
    const ownerSpend =
      ownerSpendResult._sum.totalSpend ?? new Prisma.Decimal(0);
    const [storeRule, ownerRule] = await Promise.all([
      tx.customerTierRule.findFirst({
        where: {
          isActive: true,
          storeId,
          syncAcrossOwnerStores: false,
          minimumSpend: { lte: storeSpend },
        },
        orderBy: { minimumSpend: 'desc' },
        include: { tier: true },
      }),
      tx.customerTierRule.findFirst({
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
    const tierRule =
      ownerRule &&
      (!storeRule || ownerRule.minimumSpend.greaterThan(storeRule.minimumSpend))
        ? ownerRule
        : storeRule;
    const tierName = tierRule
      ? 'tier' in tierRule && tierRule.tier
        ? tierRule.tier.name
        : tierRule.name
      : null;

    if (tierRule?.syncAcrossOwnerStores) {
      await tx.customerStore.updateMany({
        where: {
          customerId,
          store: { ownerId: store.ownerId },
        },
        data: {
          tier: tierName,
          currentTierRuleId: tierRule.id,
          currentTierId: tierRule.tierId,
        },
      });
    } else {
      await tx.customerStore.update({
        where: { id: customerStore.id },
        data: {
          tier: tierName,
          currentTierRuleId: tierRule?.id ?? null,
          currentTierId: tierRule?.tierId ?? null,
        },
      });
    }

    await tx.customer.update({
      where: { id: customerId },
      data: {
        tier: tierRule?.syncAcrossOwnerStores ? tierName : undefined,
      },
    });
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

    return `${yyyymmdd}-${String(count + 1).padStart(6, '0')}`;
  }

  private buildCheckoutReceiptData(
    transaction: TransactionWithRelations,
    validated: ValidatedCart,
  ): Prisma.InputJsonObject {
    return {
      transactionId: transaction.id,
      receiptNumber: transaction.receiptNumber,
      date: transaction.createdAt.toISOString(),
      store: transaction.store.name,
      cashier: transaction.staff.name ?? transaction.staff.id,
      customer: transaction.customer
        ? `${transaction.customer.firstName} ${transaction.customer.lastName}`
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
      subtotal: this.moneyToString(validated.subtotal),
      discount: this.moneyToString(validated.discountTotal),
      tax: this.moneyToString(validated.taxTotal),
      total: this.moneyToString(validated.total),
      paymentMethod: transaction.paymentMethod,
    };
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
      receipt: transaction.receipt
        ? {
            id: transaction.receipt.id,
            transactionId: transaction.receipt.transactionId,
            receiptNumber: transaction.receipt.receiptNumber,
            receiptData: transaction.receipt.receiptData,
            createdAt: transaction.receipt.createdAt,
          }
        : null,
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

  private parseCartCheckoutBody(
    body: Record<string, unknown>,
  ): CartCheckoutDto {
    return {
      cartId: this.requiredString(body.cartId, 'cartId'),
      paymentMethod: this.requiredEnum(
        body.paymentMethod,
        'paymentMethod',
        PaymentMethod,
      ),
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

  private getPurchaseHistoryCutoff() {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 60);

    return cutoff;
  }

  private async lockCart(tx: Prisma.TransactionClient, cartId: string) {
    await tx.$executeRaw`SELECT id FROM "Cart" WHERE id = ${this.requiredString(
      cartId,
      'cartId',
    )} FOR UPDATE`;
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
    receipt: true,
  } satisfies Prisma.TransactionInclude;

  private readonly checkoutCartInclude = {
    customer: {
      include: {
        stores: {
          include: {
            currentTier: true,
            currentTierRule: true,
          },
        },
      },
    },
    items: {
      orderBy: { createdAt: 'asc' },
      include: {
        product: {
          include: {
            tax: true,
          },
        },
      },
    },
  } satisfies Prisma.CartInclude;
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

type CartCheckoutDto = {
  cartId: string;
  paymentMethod: PaymentMethod;
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
    receipt: true;
  };
}>;

type CheckoutCart = Prisma.CartGetPayload<{
  include: {
    customer: {
      include: {
        stores: {
          include: {
            currentTier: true;
            currentTierRule: true;
          };
        };
      };
    };
    items: {
      orderBy: { createdAt: 'asc' };
      include: {
        product: {
          include: {
            tax: true;
          };
        };
      };
    };
  };
}>;

type CheckoutItemCalculation = {
  item: CheckoutCart['items'][number];
  originalSubtotal: Prisma.Decimal;
  lineSubtotal: Prisma.Decimal;
  itemDiscount: Prisma.Decimal;
  loyaltyDiscount: Prisma.Decimal;
};
