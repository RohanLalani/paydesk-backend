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
  StoreSubscriptionStatus,
  SubscriptionPlan,
} from '@prisma/client';
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
    this.logCheckoutCheckpoint('Checkout request received', {});
    this.logCheckoutCheckpoint('authenticated user ID', {
      userId: user.accountId,
    });
    this.logCheckoutCheckpoint('request storeId', {
      storeId: typeof body.storeId === 'string' ? body.storeId : undefined,
    });
    this.logCheckoutCheckpoint('request plan', {
      plan: typeof body.plan === 'string' ? body.plan : undefined,
    });

    try {
      return await this.createCheckoutSessionUnsafe(body, user);
    } catch (error: unknown) {
      this.logCheckoutError(error);
      this.logCheckoutFailureHint(error);
      throw error;
    }
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
    const stripeSecretKey = this.optionalConfig('STRIPE_SECRET_KEY');
    const plusPriceId = this.optionalConfig('STRIPE_PLUS_PRICE_ID');
    const advancedPriceId = this.optionalConfig('STRIPE_ADVANCED_PRICE_ID');
    const backofficeUrl = this.optionalConfig('BACKOFFICE_URL');

    this.logCheckoutCheckpoint('whether STRIPE_SECRET_KEY is configured', {
      configured: Boolean(stripeSecretKey),
      mode: this.stripeSecretMode(stripeSecretKey),
    });
    this.logCheckoutCheckpoint('whether STRIPE_PLUS_PRICE_ID is configured', {
      configured: Boolean(plusPriceId),
      priceIdPrefix: this.stripeIdPrefix(plusPriceId),
    });
    this.logCheckoutCheckpoint(
      'whether STRIPE_ADVANCED_PRICE_ID is configured',
      {
        configured: Boolean(advancedPriceId),
        priceIdPrefix: this.stripeIdPrefix(advancedPriceId),
      },
    );
    this.logCheckoutCheckpoint('whether BACKOFFICE_URL is configured', {
      configured: Boolean(backofficeUrl),
      fallbackConfigured: Boolean(
        this.optionalConfig('BACKOFFICE_FRONTEND_URL') ??
        this.optionalConfig('FRONTEND_URL'),
      ),
    });

    const stripePriceId = this.getPriceId(checkoutPlan);
    const frontendUrl = this.getFrontendUrl();

    const store = await this.prisma.store.findUnique({
      where: { id: storeId },
      include: {
        owner: { select: { id: true, email: true, name: true } },
      },
    });

    this.logCheckoutCheckpoint('store lookup completion', {
      storeId,
      found: Boolean(store),
      isActive: store?.isActive,
      ownerMatchesUser: store?.ownerId === user.accountId,
      ownerEmailConfigured: Boolean(store?.owner.email),
      ownerNameConfigured: Boolean(store?.owner.name),
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

    this.logCheckoutCheckpoint('subscription database lookup completion', {
      storeId,
      found: Boolean(existingStoreSubscription),
      status: existingStoreSubscription?.status,
      plan: existingStoreSubscription?.plan,
      hasStripeCustomerId: Boolean(existingStoreSubscription?.stripeCustomerId),
      hasStripeSubscriptionId: Boolean(
        existingStoreSubscription?.stripeSubscriptionId,
      ),
      hasStripeCheckoutSessionId: Boolean(
        existingStoreSubscription?.stripeCheckoutSessionId,
      ),
    });

    if (
      existingStoreSubscription &&
      BLOCKED_CHECKOUT_STATUSES.has(existingStoreSubscription.status)
    ) {
      throw new BadRequestException(
        'Store already has an active or pending subscription',
      );
    }

    this.logCheckoutCheckpoint('permission validation completion', {
      storeId,
      userId: user.accountId,
      isOwner: user.type === StaffRole.owner,
      ownerMatchesStore: store.ownerId === user.accountId,
      storeIsInactive: !store.isActive,
      existingSubscriptionAllowsCheckout: !(
        existingStoreSubscription &&
        BLOCKED_CHECKOUT_STATUSES.has(existingStoreSubscription.status)
      ),
    });

    const stripe = this.getStripe();
    const customer = await stripe.customers.create({
      email: store.owner.email,
      name: store.owner.name ?? undefined,
      metadata: {
        storeId,
        ownerId: store.ownerId,
        paydeskAccountId: user.accountId,
      },
    });

    this.logCheckoutCheckpoint('Stripe customer creation completion', {
      storeId,
      customerId: customer.id,
      ownerEmailConfigured: Boolean(store.owner.email),
      ownerNameConfigured: Boolean(store.owner.name),
    });

    const successUrl = new URL('/billing/success', frontendUrl);
    successUrl.searchParams.set('session_id', '{CHECKOUT_SESSION_ID}');
    successUrl.searchParams.set('storeId', storeId);

    const cancelUrl = new URL('/billing/cancel', frontendUrl);
    cancelUrl.searchParams.set('storeId', storeId);

    const sessionParams: Stripe.Checkout.SessionCreateParams = {
      mode: 'subscription',
      customer: customer.id,
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

    this.logCheckoutCheckpoint(
      'immediately before Stripe checkout.sessions.create',
      {
        storeId,
        checkoutPlan,
        customerId: customer.id,
        priceIdPrefix: this.stripeIdPrefix(stripePriceId),
        successUrlOrigin: successUrl.origin,
        cancelUrlOrigin: cancelUrl.origin,
      },
    );

    const session = await stripe.checkout.sessions.create(sessionParams, {
      idempotencyKey: `store-checkout:${storeId}:${checkoutPlan}`,
    });

    this.logCheckoutCheckpoint(
      'immediately after Stripe checkout.sessions.create',
      {
        storeId,
        checkoutSessionId: session.id,
        checkoutUrlConfigured: Boolean(session.url),
      },
    );

    if (!session.url) {
      throw new ServiceUnavailableException('Stripe session creation failed');
    }

    this.logCheckoutCheckpoint(
      'immediately before any Prisma subscription create/update operation',
      {
        storeId,
        plan,
        status: StoreSubscriptionStatus.pending,
        hasStripeCustomerId: Boolean(customer.id),
        hasStripeCheckoutSessionId: Boolean(session.id),
        priceIdPrefix: this.stripeIdPrefix(stripePriceId),
      },
    );

    await this.prisma.storeSubscription.upsert({
      where: { storeId },
      create: {
        storeId,
        plan,
        status: StoreSubscriptionStatus.pending,
        stripeCustomerId: customer.id,
        stripeCheckoutSessionId: session.id,
        stripePriceId,
      },
      update: {
        plan,
        status: StoreSubscriptionStatus.pending,
        stripeCustomerId: customer.id,
        stripeCheckoutSessionId: session.id,
        stripePriceId,
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

  private logCheckoutCheckpoint(
    checkpoint: string,
    details: Record<string, unknown>,
  ) {
    const payload = { checkpoint, ...details };

    this.logger.log(checkpoint, JSON.stringify(payload));
    console.error(checkpoint, payload);
  }

  private logCheckoutError(error: unknown) {
    const payload = this.checkoutErrorPayload(error);

    this.logger.error('CHECKOUT SESSION ERROR', payload.stack);
    console.error('CHECKOUT SESSION ERROR', payload);
  }

  private logCheckoutFailureHint(error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    const code = this.errorValue(error, 'code');
    const type = this.errorValue(error, 'type');
    const meta = this.errorValue(error, 'meta');
    const hints: string[] = [];

    if (message.includes('STRIPE_SECRET_KEY is not configured')) {
      hints.push('missing STRIPE_SECRET_KEY');
    }

    if (message.includes('STRIPE_PLUS_PRICE_ID is not configured')) {
      hints.push('missing STRIPE_PLUS_PRICE_ID');
    }

    if (message.includes('STRIPE_ADVANCED_PRICE_ID is not configured')) {
      hints.push('missing STRIPE_ADVANCED_PRICE_ID');
    }

    if (message.includes('Invalid URL')) {
      hints.push('malformed BACKOFFICE_URL');
    }

    if (message.includes('plan must be PLUS or ADVANCED')) {
      hints.push('incorrect plan enum values');
    }

    if (typeof code === 'string' && code === 'resource_missing') {
      hints.push(
        'Stripe resource missing: check price id, test/live mode mismatch, or Stripe sandbox/account mismatch',
      );
    }

    if (
      typeof type === 'string' &&
      (type === 'StripeInvalidRequestError' || type === 'invalid_request_error')
    ) {
      hints.push(
        'Stripe rejected checkout request: check Price IDs, customer fields, and account mode',
      );
    }

    if (
      typeof code === 'string' &&
      (code === 'P2021' || code === 'P2022' || code === 'P2023')
    ) {
      hints.push('Prisma billing migrations may not be deployed');
    }

    if (typeof code === 'string' && code === 'P2002') {
      hints.push('database uniqueness conflict');
    }

    if (message.toLowerCase().includes('customer')) {
      hints.push('missing or invalid Stripe customer fields');
    }

    if (hints.length) {
      const payload = { message, code, type, meta, hints };

      this.logger.error('CHECKOUT SESSION FAILURE HINTS');
      console.error('CHECKOUT SESSION FAILURE HINTS', payload);
    }
  }

  private checkoutErrorPayload(error: unknown) {
    return {
      name: error instanceof Error ? error.name : undefined,
      message: error instanceof Error ? error.message : String(error),
      code: this.errorValue(error, 'code'),
      type: this.errorValue(error, 'type'),
      requestId: this.errorValue(error, 'requestId'),
      meta: this.errorValue(error, 'meta'),
      stack: error instanceof Error ? error.stack : undefined,
    };
  }

  private stripeSecretMode(value?: string) {
    if (!value) {
      return 'missing';
    }

    if (value.startsWith('sk_test_')) {
      return 'test';
    }

    if (value.startsWith('sk_live_')) {
      return 'live';
    }

    return 'unknown';
  }

  private stripeIdPrefix(value?: string) {
    if (!value) {
      return undefined;
    }

    return value.split('_').slice(0, 2).join('_');
  }

  private errorValue(error: unknown, key: string) {
    if (!error || typeof error !== 'object' || !(key in error)) {
      return undefined;
    }

    return (error as Record<string, unknown>)[key];
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
