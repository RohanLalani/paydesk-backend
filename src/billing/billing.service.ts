import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  Prisma,
  StaffRole,
  StoreSubscription,
  StoreSubscriptionStatus,
  SubscriptionPlan,
} from '@prisma/client';
import * as crypto from 'crypto';
import Stripe from 'stripe';
import { AuthTokenPayload } from '../auth/strategies/jwt.strategy';
import { PrismaService } from '../prisma.service';
import { StoreService } from '../store/store.service';

type CheckoutPlan = 'PLUS' | 'ADVANCED';
const BLOCKED_CHECKOUT_STATUSES = new Set<StoreSubscriptionStatus>([
  StoreSubscriptionStatus.active,
  StoreSubscriptionStatus.trialing,
]);

@Injectable()
export class BillingService {
  private readonly logger = new Logger(BillingService.name);
  private stripe?: Stripe;

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
    private readonly storeService: StoreService,
  ) {}

  async createCheckoutSession(
    body: Record<string, unknown>,
    user: AuthTokenPayload,
  ) {
    return this.createCheckoutSessionUnsafe(body, user);
  }

  async getStoreActivationStatus(storeId: string, user: AuthTokenPayload) {
    const normalizedStoreId = this.requiredString(storeId, 'storeId');
    const store = await this.prisma.store.findUnique({
      where: { id: normalizedStoreId },
      select: {
        id: true,
        name: true,
        address: true,
        businessType: true,
        isActive: true,
        ownerId: true,
        storeSubscription: {
          select: {
            status: true,
            plan: true,
          },
        },
      },
    });

    if (!store) {
      throw new NotFoundException('Store not found');
    }

    if (user.type !== StaffRole.owner || store.ownerId !== user.accountId) {
      throw new ForbiddenException(
        'Only the store owner can view activation status',
      );
    }

    return {
      storeId: store.id,
      name: store.name,
      address: store.address,
      businessType: store.businessType,
      isActive: store.isActive,
      subscriptionStatus: store.storeSubscription?.status ?? null,
      plan: store.storeSubscription?.plan ?? null,
    };
  }

  private async createCheckoutSessionUnsafe(
    body: Record<string, unknown>,
    user: AuthTokenPayload,
  ) {
    if (user.type !== StaffRole.owner) {
      throw new ForbiddenException('Only owners can activate stores');
    }

    const storeId = this.requiredString(body.storeId, 'storeId');
    const checkoutPlan = this.requiredCheckoutPlan(body.plan);
    const plan = this.toSubscriptionPlan(checkoutPlan);
    const stripePriceId = this.getPriceId(checkoutPlan);
    const frontendUrl = this.getFrontendUrl();
    const stripe = this.getStripe();

    const store = await this.prisma.store.findUnique({
      where: { id: storeId },
      include: {
        owner: { select: { id: true, email: true, name: true } },
      },
    });

    if (!store) {
      throw new NotFoundException('Store not found');
    }

    if (store.ownerId !== user.accountId) {
      throw new ForbiddenException('You do not have access to this store');
    }

    if (store.isActive) {
      throw new BadRequestException('Store is already active');
    }

    const existingStoreSubscription =
      await this.prisma.storeSubscription.findUnique({
        where: { storeId },
      });

    if (
      existingStoreSubscription &&
      BLOCKED_CHECKOUT_STATUSES.has(existingStoreSubscription.status)
    ) {
      throw new BadRequestException(
        'Store already has an active or pending subscription',
      );
    }

    const reusableSession = await this.getReusableCheckoutSession(
      existingStoreSubscription,
      stripe,
    );

    if (reusableSession?.url) {
      return {
        checkoutUrl: reusableSession.url,
        checkoutSessionId: reusableSession.id,
      };
    }

    const customerId =
      existingStoreSubscription?.stripeCustomerId ??
      (
        await stripe.customers.create({
          email: store.owner.email,
          name: store.owner.name ?? undefined,
          metadata: {
            storeId,
            ownerId: store.ownerId,
            paydeskAccountId: user.accountId,
          },
        })
      ).id;

    const successUrl = new URL('/billing/success', frontendUrl);
    successUrl.searchParams.set('session_id', '{CHECKOUT_SESSION_ID}');
    successUrl.searchParams.set('storeId', storeId);

    const cancelUrl = new URL('/billing/cancel', frontendUrl);
    cancelUrl.searchParams.set('storeId', storeId);

    const sessionParams: Stripe.Checkout.SessionCreateParams = {
      mode: 'subscription',
      customer: customerId,
      line_items: [{ price: stripePriceId, quantity: 1 }],
      success_url: successUrl.toString(),
      cancel_url: cancelUrl.toString(),
      metadata: {
        storeId,
        plan: checkoutPlan,
        ownerId: store.ownerId,
        paydeskAccountId: user.accountId,
      },
      subscription_data: {
        metadata: {
          storeId,
          plan: checkoutPlan,
          ownerId: store.ownerId,
          paydeskAccountId: user.accountId,
        },
      },
    };

    const checkoutAttempt = this.getCheckoutAttempt(
      existingStoreSubscription,
      storeId,
      checkoutPlan,
      stripePriceId,
    );

    await this.prisma.storeSubscription.upsert({
      where: { storeId },
      create: {
        storeId,
        plan,
        status: StoreSubscriptionStatus.pending,
        stripeCustomerId: customerId,
        stripePriceId,
        checkoutAttemptId: checkoutAttempt.checkoutAttemptId,
        checkoutIdempotencyKey: checkoutAttempt.idempotencyKey,
      },
      update: {
        plan,
        status: StoreSubscriptionStatus.pending,
        stripeCustomerId: customerId,
        stripePriceId,
        checkoutAttemptId: checkoutAttempt.checkoutAttemptId,
        checkoutIdempotencyKey: checkoutAttempt.idempotencyKey,
      },
    });

    const session = await stripe.checkout.sessions.create(sessionParams, {
      idempotencyKey: checkoutAttempt.idempotencyKey,
    });

    if (!session.url) {
      throw new ServiceUnavailableException('Stripe session creation failed');
    }

    await this.prisma.storeSubscription.update({
      where: { storeId },
      data: {
        stripeCheckoutSessionId: session.id,
        checkoutSessionExpiresAt: this.fromUnix(session.expires_at),
      },
    });

    return {
      checkoutUrl: session.url,
      checkoutSessionId: session.id,
    };
  }

  async handleWebhook(rawBody: Buffer, signature?: string) {
    if (!signature) {
      throw new UnauthorizedException('Missing Stripe signature');
    }

    let event: Stripe.Event;

    try {
      event = this.getStripe().webhooks.constructEvent(
        rawBody,
        signature,
        this.requiredConfig('STRIPE_WEBHOOK_SECRET'),
      );
    } catch (error) {
      this.logger.warn(
        `Stripe webhook signature verification failed: ${
          error instanceof Error ? error.message : 'unknown error'
        }`,
      );
      throw new UnauthorizedException('Invalid Stripe signature');
    }

    const existing = await this.prisma.stripeWebhookEvent.findUnique({
      where: { id: event.id },
    });

    if (existing) {
      return { received: true, duplicate: true };
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.stripeWebhookEvent.create({
        data: { id: event.id, type: event.type },
      });

      await this.processVerifiedEvent(event, tx);
    });

    return { received: true };
  }

  private async processVerifiedEvent(
    event: Stripe.Event,
    tx: Prisma.TransactionClient,
  ) {
    switch (event.type) {
      case 'checkout.session.completed':
        await this.handleCheckoutCompleted(event.data.object, tx);
        return;
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
        await this.syncSubscription(event.data.object, tx);
        return;
      case 'customer.subscription.deleted':
        await this.syncSubscription(event.data.object, tx);
        return;
      case 'invoice.paid':
      case 'invoice.payment_failed':
        await this.syncInvoiceSubscription(event.data.object, tx);
        return;
      default:
        this.logger.debug(`Ignoring Stripe event ${event.type}`);
    }
  }

  private async handleCheckoutCompleted(
    session: Stripe.Checkout.Session,
    tx: Prisma.TransactionClient,
  ) {
    if (session.mode !== 'subscription') {
      return;
    }

    const storeId = session.metadata?.storeId;
    const plan = this.metadataPlan(session.metadata?.plan);

    if (!storeId || !plan) {
      this.logger.warn(
        `Stripe checkout session ${session.id} missing trusted metadata`,
      );
      return;
    }

    const subscriptionId = this.toStripeId(session.subscription);
    const customerId = this.toStripeId(session.customer);

    await tx.storeSubscription.upsert({
      where: { storeId },
      create: {
        storeId,
        plan,
        status: StoreSubscriptionStatus.pending,
        stripeCustomerId: customerId,
        stripeSubscriptionId: subscriptionId,
        stripeCheckoutSessionId: session.id,
      },
      update: {
        plan,
        stripeCustomerId: customerId,
        stripeSubscriptionId: subscriptionId,
        stripeCheckoutSessionId: session.id,
      },
    });
  }

  private async syncInvoiceSubscription(
    invoice: Stripe.Invoice,
    tx: Prisma.TransactionClient,
  ) {
    const subscriptionId = this.toStripeId(
      (
        invoice as Stripe.Invoice & {
          subscription?: string | Stripe.Subscription;
        }
      ).subscription,
    );

    if (!subscriptionId) {
      return;
    }

    const subscription =
      await this.getStripe().subscriptions.retrieve(subscriptionId);
    await this.syncSubscription(subscription, tx);
  }

  private async syncSubscription(
    subscription: Stripe.Subscription,
    tx: Prisma.TransactionClient,
  ) {
    const storeId =
      subscription.metadata?.storeId ??
      (
        await tx.storeSubscription.findUnique({
          where: { stripeSubscriptionId: subscription.id },
        })
      )?.storeId;

    if (!storeId) {
      this.logger.warn(
        `Stripe subscription ${subscription.id} missing store metadata`,
      );
      return;
    }

    const existingStore = await tx.store.findUnique({
      where: { id: storeId },
      select: { id: true },
    });

    if (!existingStore) {
      this.logger.warn(
        `Stripe subscription ${subscription.id} references missing store ${storeId}`,
      );
      return;
    }

    const plan =
      this.metadataPlan(subscription.metadata?.plan) ??
      this.planFromPrice(subscription.items.data[0]?.price.id);
    const status = this.mapStripeStatus(subscription.status);
    const usable = this.isUsableStatus(status);
    const priceId = subscription.items.data[0]?.price.id;
    const subscriptionWithPeriods = subscription as Stripe.Subscription & {
      current_period_start?: number;
      current_period_end?: number;
    };

    await tx.storeSubscription.upsert({
      where: { storeId },
      create: {
        storeId,
        plan,
        status,
        stripeCustomerId: this.toStripeId(subscription.customer),
        stripeSubscriptionId: subscription.id,
        stripePriceId: priceId,
        currentPeriodStart: this.fromUnix(
          subscriptionWithPeriods.current_period_start,
        ),
        currentPeriodEnd: this.fromUnix(
          subscriptionWithPeriods.current_period_end,
        ),
        cancelAtPeriodEnd: subscription.cancel_at_period_end,
      },
      update: {
        plan,
        status,
        stripeCustomerId: this.toStripeId(subscription.customer),
        stripeSubscriptionId: subscription.id,
        stripePriceId: priceId,
        currentPeriodStart: this.fromUnix(
          subscriptionWithPeriods.current_period_start,
        ),
        currentPeriodEnd: this.fromUnix(
          subscriptionWithPeriods.current_period_end,
        ),
        cancelAtPeriodEnd: subscription.cancel_at_period_end,
      },
    });

    await tx.store.update({
      where: { id: storeId },
      data: { isActive: usable },
    });

    const store = await tx.store.findUnique({
      where: { id: storeId },
      select: { ownerId: true },
    });

    if (store) {
      await this.storeService.updateOwnerBilling(store.ownerId, tx);
    }
  }

  private async getReusableCheckoutSession(
    existingStoreSubscription: StoreSubscription | null,
    stripe: Stripe,
  ) {
    if (!existingStoreSubscription?.stripeCheckoutSessionId) {
      return null;
    }

    try {
      const session = await stripe.checkout.sessions.retrieve(
        existingStoreSubscription.stripeCheckoutSessionId,
      );

      if (this.isReusableCheckoutSession(session)) {
        return session;
      }
    } catch (error: unknown) {
      this.logger.warn(
        `Could not retrieve Stripe checkout session ${existingStoreSubscription.stripeCheckoutSessionId}: ${
          error instanceof Error ? error.message : 'unknown error'
        }`,
      );
    }

    return null;
  }

  private isReusableCheckoutSession(session: Stripe.Checkout.Session) {
    return (
      session.status === 'open' &&
      Boolean(session.url) &&
      !this.isCheckoutSessionExpired(session.expires_at)
    );
  }

  private isCheckoutSessionExpired(expiresAt?: number | null) {
    if (!expiresAt) {
      return false;
    }

    return expiresAt <= Math.floor(Date.now() / 1000);
  }

  private getCheckoutAttempt(
    existingStoreSubscription: StoreSubscription | null,
    storeId: string,
    checkoutPlan: CheckoutPlan,
    stripePriceId: string,
  ) {
    const plan = this.toSubscriptionPlan(checkoutPlan);

    if (
      existingStoreSubscription?.checkoutAttemptId &&
      existingStoreSubscription.checkoutIdempotencyKey &&
      !existingStoreSubscription.stripeCheckoutSessionId &&
      existingStoreSubscription.plan === plan &&
      existingStoreSubscription.stripePriceId === stripePriceId
    ) {
      return {
        checkoutAttemptId: existingStoreSubscription.checkoutAttemptId,
        idempotencyKey: existingStoreSubscription.checkoutIdempotencyKey,
      };
    }

    const checkoutAttemptId = this.createCheckoutAttemptId();

    return {
      checkoutAttemptId,
      idempotencyKey: `store-checkout:${storeId}:${checkoutPlan}:${checkoutAttemptId}`,
    };
  }

  private createCheckoutAttemptId() {
    return crypto.randomUUID();
  }

  private requiredString(value: unknown, field: string) {
    if (typeof value !== 'string' || !value.trim()) {
      throw new BadRequestException(`${field} is required`);
    }

    return value.trim();
  }

  private requiredCheckoutPlan(value: unknown): CheckoutPlan {
    if (value !== 'PLUS' && value !== 'ADVANCED') {
      throw new BadRequestException('plan must be PLUS or ADVANCED');
    }

    return value;
  }

  private metadataPlan(value: unknown) {
    if (value === 'PLUS' || value === 'ADVANCED') {
      return this.toSubscriptionPlan(value);
    }

    return null;
  }

  private toSubscriptionPlan(plan: CheckoutPlan) {
    return plan === 'PLUS' ? SubscriptionPlan.plus : SubscriptionPlan.advanced;
  }

  private getPriceId(plan: CheckoutPlan) {
    return this.requiredConfig(
      plan === 'PLUS' ? 'STRIPE_PLUS_PRICE_ID' : 'STRIPE_ADVANCED_PRICE_ID',
    );
  }

  private planFromPrice(priceId?: string) {
    if (priceId === this.optionalConfig('STRIPE_ADVANCED_PRICE_ID')) {
      return SubscriptionPlan.advanced;
    }

    return SubscriptionPlan.plus;
  }

  private mapStripeStatus(status: Stripe.Subscription.Status) {
    switch (status) {
      case 'active':
        return StoreSubscriptionStatus.active;
      case 'trialing':
        return StoreSubscriptionStatus.trialing;
      case 'past_due':
        return StoreSubscriptionStatus.past_due;
      case 'canceled':
        return StoreSubscriptionStatus.canceled;
      case 'unpaid':
        return StoreSubscriptionStatus.unpaid;
      case 'incomplete_expired':
        return StoreSubscriptionStatus.incomplete_expired;
      case 'paused':
        return StoreSubscriptionStatus.paused;
      case 'incomplete':
      default:
        return StoreSubscriptionStatus.incomplete;
    }
  }

  private isUsableStatus(status: StoreSubscriptionStatus) {
    return (
      status === StoreSubscriptionStatus.active ||
      status === StoreSubscriptionStatus.trialing
    );
  }

  private getFrontendUrl() {
    return (
      this.optionalConfig('BACKOFFICE_URL') ??
      this.optionalConfig('BACKOFFICE_FRONTEND_URL') ??
      this.optionalConfig('FRONTEND_URL') ??
      'http://localhost:3000'
    );
  }

  private getStripe() {
    if (!this.stripe) {
      this.stripe = new Stripe(this.requiredConfig('STRIPE_SECRET_KEY'));
    }

    return this.stripe;
  }

  private optionalConfig(key: string) {
    const value = this.configService.get<string>(key);
    return value?.trim() || undefined;
  }

  private requiredConfig(key: string) {
    const value = this.optionalConfig(key);

    if (!value) {
      throw new ServiceUnavailableException(`${key} is not configured`);
    }

    return value;
  }

  private toStripeId(value: string | { id: string } | null | undefined) {
    if (!value) {
      return null;
    }

    return typeof value === 'string' ? value : value.id;
  }

  private fromUnix(value?: number) {
    return value ? new Date(value * 1000) : null;
  }
}
