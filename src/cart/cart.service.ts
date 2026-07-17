import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  CartStatus,
  CustomerTierDiscountModel,
  Prisma,
  TaxStyle,
} from '@prisma/client';
import { AuthTokenPayload } from '../auth/strategies/jwt.strategy';
import { PosAccessService } from '../common/pos-access.service';
import { TaxCalculationService } from '../common/tax-calculation.service';
import { PrismaService } from '../prisma.service';

@Injectable()
export class CartService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: PosAccessService,
    private readonly taxCalculation: TaxCalculationService,
  ) {}

  async start(body: Record<string, unknown>, user: AuthTokenPayload) {
    const storeId = this.requiredString(body.storeId, 'storeId');
    await this.access.ensureStoreAccess(storeId, user, 'process_sales');

    const cart = await this.prisma.cart.create({
      data: {
        storeId,
        staffId: user.staffId,
      },
      include: this.cartInclude,
    });

    return this.toCartResponse(cart);
  }

  async addBarcode(
    cartId: string,
    body: Record<string, unknown>,
    user: AuthTokenPayload,
  ) {
    const dto = {
      storeId: this.requiredString(body.storeId, 'storeId'),
      barcode: this.requiredString(body.barcode, 'barcode'),
      quantity:
        body.quantity === undefined
          ? 1
          : this.requiredPositiveInt(body.quantity, 'quantity'),
    };
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await this.addBarcodeAttempt(cartId, dto, user);
      } catch (error) {
        if (this.shouldRetryCartWrite(error) && attempt < 2) {
          continue;
        }

        throw error;
      }
    }

    throw new ConflictException('Unable to update cart item');
  }

  private async addBarcodeAttempt(
    cartId: string,
    dto: { storeId: string; barcode: string; quantity: number },
    user: AuthTokenPayload,
  ) {
    return this.prisma.$transaction(async (tx) => {
      await this.lockCart(tx, cartId);

      const cart = await this.getActiveCartForUser(cartId, user, tx);

      this.ensureCartStore(cart, dto.storeId);

      const product = await this.getLockedProductByBarcode(
        tx,
        cart.storeId,
        dto.barcode,
      );

      const existingItem = cart.items.find(
        (item) => item.productId === product.id,
      );
      const nextQuantity = (existingItem?.quantity ?? 0) + dto.quantity;

      this.validateProductQuantity(product, nextQuantity);

      const updateResult = existingItem
        ? await tx.cartItem.updateMany({
            where: {
              id: existingItem.id,
              quantity:
                product.trackInventory && !product.allowNegativeInventory
                  ? { lte: product.currentQuantity - dto.quantity }
                  : undefined,
            },
            data: {
              quantity: { increment: dto.quantity },
            },
          })
        : await this.createCartItem(tx, cart.id, product, dto.quantity);

      if (existingItem && updateResult.count !== 1) {
        throw new BadRequestException(
          `${product.name} does not have enough inventory`,
        );
      }

      return this.toCartResponse(await this.getCartOrThrow(tx, cart.id));
    });
  }

  private async createCartItem(
    tx: Prisma.TransactionClient,
    cartId: string,
    product: CartProduct,
    quantity: number,
  ) {
    await tx.cartItem.create({
      data: {
        cartId,
        productId: product.id,
        quantity,
        originalUnitPrice: this.money(product.unitRetail),
        unitPrice: this.money(product.unitRetail),
      },
    });

    return { count: 1 };
  }

  async updateQuantity(
    cartId: string,
    itemId: string,
    body: Record<string, unknown>,
    user: AuthTokenPayload,
  ) {
    const quantity = this.requiredPositiveInt(body.quantity, 'quantity');

    return this.prisma.$transaction(async (tx) => {
      await this.lockCart(tx, cartId);

      const cart = await this.getActiveCartForUser(cartId, user, tx);
      const item = this.findItemInCart(cart, itemId);
      const product = await this.getLockedProductById(tx, item.productId);

      this.validateProductQuantity(product, quantity);

      await tx.cartItem.update({
        where: { id: item.id },
        data: { quantity },
      });

      return this.toCartResponse(await this.getCartOrThrow(tx, cart.id));
    });
  }

  async priceOverride(
    cartId: string,
    itemId: string,
    body: Record<string, unknown>,
    user: AuthTokenPayload,
  ) {
    const dto = {
      price: this.requiredMoney(body.price, 'price'),
      reason: this.requiredString(body.reason, 'reason'),
    };

    if (dto.reason.length > 500) {
      throw new BadRequestException('reason cannot exceed 500 characters');
    }

    return this.prisma.$transaction(async (tx) => {
      await this.lockCart(tx, cartId);

      const cart = await this.getActiveCartForUser(cartId, user, tx);
      await this.access.ensureStoreAccess(
        cart.storeId,
        user,
        'override_prices',
      );
      const item = this.findItemInCart(cart, itemId);

      await this.lockCartItem(tx, item.id);

      await tx.cartItem.update({
        where: { id: item.id },
        data: {
          unitPrice: dto.price,
          priceOverrideReason: dto.reason,
        },
      });

      return this.toCartResponse(await this.getCartOrThrow(tx, cart.id));
    });
  }

  async attachCustomerByPhone(
    cartId: string,
    body: Record<string, unknown>,
    user: AuthTokenPayload,
  ) {
    const phone = this.requiredString(body.phone, 'phone');
    return this.prisma.$transaction(async (tx) => {
      await this.lockCart(tx, cartId);

      const cart = await this.getActiveCartForUser(cartId, user, tx);
      const customer = await tx.customer.findUnique({
        where: { phone },
        include: {
          stores: {
            where: { storeId: cart.storeId },
            include: {
              currentTier: true,
              currentTierRule: true,
            },
          },
        },
      });

      if (!customer) {
        throw new NotFoundException('Customer not found');
      }

      if (!customer.stores.length) {
        throw new ForbiddenException('Customer is not linked to this store');
      }

      await tx.cart.update({
        where: { id: cart.id },
        data: { customerId: customer.id },
      });

      return this.toCartResponse(await this.getCartOrThrow(tx, cart.id));
    });
  }

  async findOne(cartId: string, user: AuthTokenPayload) {
    const cart = await this.getCartForUser(cartId, user);

    return this.toCartResponse(cart);
  }

  async preparePayment(cartId: string, user: AuthTokenPayload) {
    return this.prisma.$transaction(async (tx) => {
      await this.lockCart(tx, cartId);

      const cart = await this.getActiveCartForUser(cartId, user, tx);

      if (!cart.items.length) {
        throw new BadRequestException('Cart is empty');
      }

      await this.validateCartQuantities(tx, cart);

      const updated = await tx.cart.update({
        where: { id: cart.id },
        data: { status: CartStatus.ready_for_payment },
        include: this.cartInclude,
      });

      return {
        ...this.toCartResponse(updated),
        paymentStatus: 'ready_for_payment',
      };
    });
  }

  private async getCartForUser(
    cartId: string,
    user: AuthTokenPayload,
    tx: CartPrismaClient = this.prisma,
    permission: 'view_store' | 'process_sales' = 'view_store',
  ) {
    const cart = await this.getCartOrThrow(tx, cartId);

    await this.access.ensureStoreAccess(cart.storeId, user, permission);

    return cart;
  }

  private async getActiveCartForUser(
    cartId: string,
    user: AuthTokenPayload,
    tx: CartPrismaClient = this.prisma,
  ) {
    const cart = await this.getCartForUser(cartId, user, tx, 'process_sales');

    if (cart.status !== CartStatus.active) {
      throw new BadRequestException('Cart is not active');
    }

    return cart;
  }

  private ensureCartStore(cart: CartWithRelations, storeId: string) {
    if (cart.storeId !== storeId) {
      throw new BadRequestException('storeId does not match cart store');
    }
  }

  private findItemInCart(cart: CartWithRelations, itemId: string) {
    const item = cart.items.find(
      (cartItem) => cartItem.id === this.requiredString(itemId, 'itemId'),
    );

    if (!item) {
      throw new NotFoundException('Cart item not found');
    }

    return item;
  }

  private async validateCartQuantities(
    tx: Prisma.TransactionClient,
    cart: CartWithRelations,
  ) {
    for (const item of cart.items) {
      const product = await this.getLockedProductById(tx, item.productId);
      this.validateProductQuantity(product, item.quantity);
    }
  }

  private validateProductQuantity(
    product: {
      name: string;
      trackInventory: boolean;
      allowNegativeInventory: boolean;
      currentQuantity: number;
    },
    quantity: number,
  ) {
    if (
      product.trackInventory &&
      !product.allowNegativeInventory &&
      quantity > product.currentQuantity
    ) {
      throw new BadRequestException(
        `${product.name} does not have enough inventory`,
      );
    }
  }

  private toCartResponse(cart: CartWithRelations) {
    const calculation = this.calculateCart(cart);

    return {
      id: cart.id,
      storeId: cart.storeId,
      status: cart.status,
      customer: cart.customer
        ? {
            id: cart.customer.id,
            customerNumber: cart.customer.customerNumber,
            firstName: cart.customer.firstName,
            lastName: cart.customer.lastName,
            phone: cart.customer.phone,
            rewardPoints: cart.customer.rewardPoints,
            tier: this.getCustomerStore(cart)?.tier ?? cart.customer.tier,
          }
        : null,
      items: calculation.items,
      totals: calculation.totals,
    };
  }

  private calculateCart(cart: CartWithRelations) {
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
    const loyaltyDiscountTotal = this.applyLoyaltyDiscounts(
      cart,
      itemCalculations,
      subtotal,
    );
    let taxTotal = this.money(0);

    const items = itemCalculations.map((calculation) => {
      const taxableAmount =
        calculation.item.product.taxStyle === TaxStyle.pre_discount
          ? calculation.lineSubtotal
          : Prisma.Decimal.max(
              calculation.lineSubtotal.minus(calculation.loyaltyDiscount),
              0,
            );
      const tax = this.taxCalculation.calculateLineTax(
        taxableAmount,
        calculation.item.product.tax,
      );
      const lineTotal = this.roundMoney(
        Prisma.Decimal.max(
          calculation.lineSubtotal.minus(calculation.loyaltyDiscount).plus(tax),
          0,
        ),
      );

      taxTotal = taxTotal.plus(tax);

      return {
        id: calculation.item.id,
        productId: calculation.item.productId,
        barcode: calculation.item.product.barcode,
        name: calculation.item.product.name,
        quantity: calculation.item.quantity,
        originalUnitPrice: this.moneyToNumber(
          calculation.item.originalUnitPrice,
        ),
        unitPrice: this.moneyToNumber(calculation.item.unitPrice),
        priceOverrideReason: calculation.item.priceOverrideReason,
        lineSubtotal: this.moneyToNumber(calculation.lineSubtotal),
        tax: this.moneyToNumber(tax),
        lineTotal: this.moneyToNumber(lineTotal),
      };
    });

    taxTotal = this.roundMoney(taxTotal);

    return {
      items,
      totals: {
        subtotal: this.moneyToNumber(subtotal),
        itemDiscountTotal: this.moneyToNumber(itemDiscountTotal),
        loyaltyDiscountTotal: this.moneyToNumber(loyaltyDiscountTotal),
        taxTotal: this.moneyToNumber(taxTotal),
        grandTotal: this.moneyToNumber(
          this.roundMoney(
            Prisma.Decimal.max(
              subtotal.minus(loyaltyDiscountTotal).plus(taxTotal),
              0,
            ),
          ),
        ),
      },
    };
  }

  private applyLoyaltyDiscounts(
    cart: CartWithRelations,
    itemCalculations: ItemCalculation[],
    subtotal: Prisma.Decimal,
  ) {
    const customerStore = this.getCustomerStore(cart);
    const tier = customerStore?.currentTier;

    if (!tier?.isActive) {
      return this.money(0);
    }

    const discountValue = this.money(tier.discountValue);
    let loyaltyDiscountTotal = this.money(0);

    if (tier.discountModel === CustomerTierDiscountModel.ORDER_PERCENTAGE) {
      loyaltyDiscountTotal = subtotal.mul(discountValue).div(100);
      this.distributeLoyaltyDiscount(itemCalculations, loyaltyDiscountTotal);
    }

    if (tier.discountModel === CustomerTierDiscountModel.ORDER_FLAT_RATE) {
      loyaltyDiscountTotal = Prisma.Decimal.min(discountValue, subtotal);
      this.distributeLoyaltyDiscount(itemCalculations, loyaltyDiscountTotal);
    }

    if (tier.discountModel === CustomerTierDiscountModel.ITEM_PERCENTAGE) {
      for (const item of itemCalculations) {
        item.loyaltyDiscount = Prisma.Decimal.min(
          item.lineSubtotal.mul(discountValue).div(100),
          item.lineSubtotal,
        );
        loyaltyDiscountTotal = loyaltyDiscountTotal.plus(item.loyaltyDiscount);
      }
    }

    if (tier.discountModel === CustomerTierDiscountModel.ITEM_FLAT_RATE) {
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

  private distributeLoyaltyDiscount(
    items: ItemCalculation[],
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

  private getCustomerStore(cart: CartWithRelations) {
    return cart.customer?.stores.find(
      (store) => store.storeId === cart.storeId,
    );
  }

  private async getCartOrThrow(tx: CartPrismaClient, cartId: string) {
    const cart = await tx.cart.findUnique({
      where: { id: this.requiredString(cartId, 'cartId') },
      include: this.cartInclude,
    });

    if (!cart) {
      throw new NotFoundException('Cart not found');
    }

    return cart;
  }

  private async getLockedProductByBarcode(
    tx: Prisma.TransactionClient,
    storeId: string,
    barcode: string,
  ) {
    const product = await tx.product.findFirst({
      where: {
        storeId,
        barcode,
        isActive: true,
      },
      select: { id: true },
    });

    if (!product) {
      throw new NotFoundException('Product not found');
    }

    return this.getLockedProductById(tx, product.id);
  }

  private async getLockedProductById(
    tx: Prisma.TransactionClient,
    productId: string,
  ) {
    await this.lockProduct(tx, productId);

    const product = await tx.product.findUnique({
      where: { id: productId },
      include: { tax: true },
    });

    if (!product?.isActive) {
      throw new NotFoundException('Product not found');
    }

    return product;
  }

  private async lockCart(tx: Prisma.TransactionClient, cartId: string) {
    await tx.$executeRaw`SELECT id FROM "Cart" WHERE id = ${this.requiredString(
      cartId,
      'cartId',
    )} FOR UPDATE`;
  }

  private async lockCartItem(tx: Prisma.TransactionClient, itemId: string) {
    await tx.$executeRaw`SELECT id FROM "CartItem" WHERE id = ${this.requiredString(
      itemId,
      'itemId',
    )} FOR UPDATE`;
  }

  private async lockProduct(tx: Prisma.TransactionClient, productId: string) {
    await tx.$executeRaw`SELECT id FROM "Product" WHERE id = ${productId} FOR UPDATE`;
  }

  private requiredString(value: unknown, field: string) {
    if (typeof value !== 'string' || !value.trim()) {
      throw new BadRequestException(`${field} is required`);
    }

    return value.trim();
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

  private money(value: Prisma.Decimal.Value) {
    return this.roundMoney(new Prisma.Decimal(value));
  }

  private roundMoney(value: Prisma.Decimal) {
    return value.toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
  }

  private moneyToNumber(value: Prisma.Decimal.Value) {
    return Number(this.money(value).toFixed(2));
  }

  private shouldRetryCartWrite(error: unknown) {
    return (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      (error.code === 'P2002' || error.code === 'P2034')
    );
  }

  private readonly cartInclude = {
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

type CartWithRelations = Prisma.CartGetPayload<{
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

type ItemCalculation = {
  item: CartWithRelations['items'][number];
  originalSubtotal: Prisma.Decimal;
  lineSubtotal: Prisma.Decimal;
  itemDiscount: Prisma.Decimal;
  loyaltyDiscount: Prisma.Decimal;
};

type CartProduct = Prisma.ProductGetPayload<{
  include: {
    tax: true;
  };
}>;

type CartPrismaClient = Prisma.TransactionClient | PrismaService;
