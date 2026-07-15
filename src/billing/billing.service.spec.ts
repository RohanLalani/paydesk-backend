/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import {
  BadRequestException,
  ForbiddenException,
  UnauthorizedException,
} from '@nestjs/common';
import {
  BillingCycle,
  StaffRole,
  StoreBusinessType,
  StoreServiceStatus,
  StoreSubscriptionStatus,
  SubscriptionPlan,
  SubscriptionStatus,
} from '@prisma/client';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma.service';
import { StoreService } from '../store/store.service';
import { BillingService } from './billing.service';

describe('BillingService Stripe checkout', () => {
  let service: BillingService;
  let prisma: MockPrisma;
  let storeService: { updateOwnerBilling: jest.Mock };
  let stripe: MockStripe;

  const ownerUser = {
    accountId: 'owner-1',
    staffId: 'staff-owner-1',
    role: StaffRole.owner,
    type: StaffRole.owner,
  };

  const partnerUser = {
    accountId: 'partner-1',
    staffId: 'staff-partner-1',
    role: StaffRole.partner,
    type: StaffRole.partner,
  };

  beforeEach(() => {
    prisma = createMockPrisma();
    storeService = { updateOwnerBilling: jest.fn() };
    stripe = createMockStripe();
    service = new BillingService(
      prisma as unknown as PrismaService,
      mockConfig() as unknown as ConfigService,
      storeService as unknown as StoreService,
    );
    (service as unknown as { stripe: MockStripe }).stripe = stripe;
  });

  it('maps PLUS to the configured Stripe Plus price id', async () => {
    await service.createCheckoutSession(
      { storeId: 'store-1', plan: 'PLUS' },
      ownerUser,
    );

    expect(stripe.checkout.sessions.create).toHaveBeenCalledWith(
      expect.objectContaining({
        line_items: [{ price: 'price_plus', quantity: 1 }],
      }),
      expect.any(Object),
    );
  });

  it('maps ADVANCED to the configured Stripe Advanced price id', async () => {
    await service.createCheckoutSession(
      { storeId: 'store-1', plan: 'ADVANCED' },
      ownerUser,
    );

    expect(stripe.checkout.sessions.create).toHaveBeenCalledWith(
      expect.objectContaining({
        line_items: [{ price: 'price_advanced', quantity: 1 }],
      }),
      expect.any(Object),
    );
  });

  it('rejects users who are not owners', async () => {
    await expect(
      service.createCheckoutSession(
        { storeId: 'store-1', plan: 'PLUS' },
        partnerUser,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('rejects owners without access to the store', async () => {
    prisma.store.findUnique.mockResolvedValue(
      storeFixture({ ownerId: 'owner-2' }),
    );

    await expect(
      service.createCheckoutSession(
        { storeId: 'store-1', plan: 'PLUS' },
        ownerUser,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('rejects already active stores', async () => {
    prisma.store.findUnique.mockResolvedValue(storeFixture({ isActive: true }));

    await expect(
      service.createCheckoutSession(
        { storeId: 'store-1', plan: 'PLUS' },
        ownerUser,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects invalid plan values', async () => {
    await expect(
      service.createCheckoutSession(
        { storeId: 'store-1', plan: 'enterprise' },
        ownerUser,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('creates checkout without activating the store', async () => {
    await service.createCheckoutSession(
      { storeId: 'store-1', plan: 'PLUS' },
      ownerUser,
    );

    expect(prisma.store.update).not.toHaveBeenCalled();
    expect(prisma.storeSubscription.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          status: StoreSubscriptionStatus.pending,
          checkoutAttemptId: expect.any(String),
          checkoutIdempotencyKey: expect.stringMatching(
            /^store-checkout:store-1:PLUS:/,
          ),
        }),
      }),
    );
  });

  it('repeated clicks during one attempt return the same open session', async () => {
    prisma.storeSubscription.findUnique.mockResolvedValue(
      storeSubscriptionFixture({
        stripeCheckoutSessionId: 'cs_open',
        stripeCustomerId: 'cus_existing',
        checkoutAttemptId: 'attempt-existing',
        checkoutIdempotencyKey: 'store-checkout:store-1:PLUS:attempt-existing',
      }),
    );
    stripe.checkout.sessions.retrieve.mockResolvedValue(
      checkoutSessionFixture({
        id: 'cs_open',
        url: 'https://checkout.stripe.test/open-session',
        status: 'open',
      }),
    );

    await expect(
      service.createCheckoutSession(
        { storeId: 'store-1', plan: 'PLUS' },
        ownerUser,
      ),
    ).resolves.toEqual({
      checkoutUrl: 'https://checkout.stripe.test/open-session',
      checkoutSessionId: 'cs_open',
    });

    expect(stripe.checkout.sessions.retrieve).toHaveBeenCalledWith('cs_open');
    expect(stripe.checkout.sessions.create).not.toHaveBeenCalled();
    expect(stripe.customers.create).not.toHaveBeenCalled();
  });

  it('a new attempt uses a different idempotency key', async () => {
    const createCheckoutAttemptId = jest.spyOn(
      service as unknown as { createCheckoutAttemptId: () => string },
      'createCheckoutAttemptId',
    );
    createCheckoutAttemptId
      .mockReturnValueOnce('11111111-1111-4111-8111-111111111111')
      .mockReturnValueOnce('22222222-2222-4222-8222-222222222222');

    await service.createCheckoutSession(
      { storeId: 'store-1', plan: 'PLUS' },
      ownerUser,
    );

    expect(stripe.checkout.sessions.create).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        idempotencyKey:
          'store-checkout:store-1:PLUS:11111111-1111-4111-8111-111111111111',
      }),
    );

    stripe.checkout.sessions.create.mockClear();
    prisma.storeSubscription.findUnique.mockResolvedValue(
      storeSubscriptionFixture({
        stripeCheckoutSessionId: 'cs_expired',
        stripeCustomerId: 'cus_existing',
        checkoutAttemptId: 'attempt-old',
        checkoutIdempotencyKey: 'store-checkout:store-1:PLUS:attempt-old',
      }),
    );
    stripe.checkout.sessions.retrieve.mockResolvedValue(
      checkoutSessionFixture({
        id: 'cs_expired',
        status: 'expired',
        url: null,
        expires_at: pastStripeTimestamp(),
      }),
    );

    await service.createCheckoutSession(
      { storeId: 'store-1', plan: 'PLUS' },
      ownerUser,
    );

    expect(stripe.checkout.sessions.create).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        idempotencyKey:
          'store-checkout:store-1:PLUS:22222222-2222-4222-8222-222222222222',
      }),
    );

    createCheckoutAttemptId.mockRestore();
  });

  it('changing the configured Price ID does not reuse an old idempotency key', async () => {
    service = new BillingService(
      prisma as unknown as PrismaService,
      mockConfig({
        STRIPE_PLUS_PRICE_ID: 'price_plus_v2',
      }) as unknown as ConfigService,
      storeService as unknown as StoreService,
    );
    (service as unknown as { stripe: MockStripe }).stripe = stripe;
    const createCheckoutAttemptId = jest
      .spyOn(
        service as unknown as { createCheckoutAttemptId: () => string },
        'createCheckoutAttemptId',
      )
      .mockReturnValue('33333333-3333-4333-8333-333333333333');
    prisma.storeSubscription.findUnique.mockResolvedValue(
      storeSubscriptionFixture({
        stripeCheckoutSessionId: null,
        checkoutAttemptId: 'attempt-old',
        checkoutIdempotencyKey: 'store-checkout:store-1:PLUS:attempt-old',
        stripePriceId: 'price_plus',
      }),
    );

    await service.createCheckoutSession(
      { storeId: 'store-1', plan: 'PLUS' },
      ownerUser,
    );

    expect(stripe.checkout.sessions.create).toHaveBeenCalledWith(
      expect.objectContaining({
        line_items: [{ price: 'price_plus_v2', quantity: 1 }],
      }),
      expect.objectContaining({
        idempotencyKey:
          'store-checkout:store-1:PLUS:33333333-3333-4333-8333-333333333333',
      }),
    );

    createCheckoutAttemptId.mockRestore();
  });

  it('an expired session results in a new session', async () => {
    prisma.storeSubscription.findUnique.mockResolvedValue(
      storeSubscriptionFixture({
        stripeCheckoutSessionId: 'cs_expired',
        stripeCustomerId: 'cus_existing',
      }),
    );
    stripe.checkout.sessions.retrieve.mockResolvedValue(
      checkoutSessionFixture({
        id: 'cs_expired',
        status: 'expired',
        url: null,
        expires_at: pastStripeTimestamp(),
      }),
    );
    stripe.checkout.sessions.create.mockResolvedValue(
      checkoutSessionFixture({
        id: 'cs_new',
        url: 'https://checkout.stripe.test/new-session',
      }),
    );

    await expect(
      service.createCheckoutSession(
        { storeId: 'store-1', plan: 'PLUS' },
        ownerUser,
      ),
    ).resolves.toEqual({
      checkoutUrl: 'https://checkout.stripe.test/new-session',
      checkoutSessionId: 'cs_new',
    });

    expect(stripe.checkout.sessions.retrieve).toHaveBeenCalledWith(
      'cs_expired',
    );
    expect(stripe.checkout.sessions.create).toHaveBeenCalledTimes(1);
    expect(prisma.storeSubscription.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          stripeCheckoutSessionId: 'cs_new',
          checkoutSessionExpiresAt: expect.any(Date),
        }),
      }),
    );
  });

  it('reuses an existing Stripe customer', async () => {
    prisma.storeSubscription.findUnique.mockResolvedValue(
      storeSubscriptionFixture({
        stripeCheckoutSessionId: null,
        stripeCustomerId: 'cus_existing',
      }),
    );

    await service.createCheckoutSession(
      { storeId: 'store-1', plan: 'PLUS' },
      ownerUser,
    );

    expect(stripe.customers.create).not.toHaveBeenCalled();
    expect(stripe.checkout.sessions.create).toHaveBeenCalledWith(
      expect.objectContaining({
        customer: 'cus_existing',
      }),
      expect.any(Object),
    );
  });

  it('returns store activation status for the owner', async () => {
    prisma.store.findUnique.mockResolvedValue(
      storeFixture({
        isActive: true,
        storeSubscription: {
          status: StoreSubscriptionStatus.active,
          plan: SubscriptionPlan.plus,
        },
      }),
    );

    await expect(
      service.getStoreActivationStatus('store-1', ownerUser),
    ).resolves.toEqual(
      expect.objectContaining({
        storeId: 'store-1',
        name: 'Downtown Store',
        address: null,
        businessType: StoreBusinessType.convenience_store,
        isActive: true,
        subscriptionStatus: StoreSubscriptionStatus.active,
        plan: SubscriptionPlan.plus,
      }),
    );
  });

  it('rejects activation status lookups for non-owners', async () => {
    await expect(
      service.getStoreActivationStatus('store-1', partnerUser),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('rejects Loyalty add-on requests without explicit charge confirmation', async () => {
    await expect(
      service.addStoreService('store-1', { service: 'LOYALTY' }, ownerUser),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(stripe.subscriptionItems.create).not.toHaveBeenCalled();
    expect(prisma.storeServiceSubscription.upsert).not.toHaveBeenCalled();
  });

  it('adds Loyalty to the existing Stripe subscription after confirmation', async () => {
    prisma.store.findUnique.mockResolvedValue(
      storeFixture({
        storeSubscription: storeSubscriptionFixture({
          status: StoreSubscriptionStatus.active,
          stripeSubscriptionId: 'sub_existing',
        }),
        serviceSubscriptions: [],
      }),
    );

    await service.addStoreService(
      'store-1',
      { service: 'LOYALTY', confirmed: true },
      ownerUser,
    );

    expect(stripe.customers.create).not.toHaveBeenCalled();
    expect(stripe.checkout.sessions.create).not.toHaveBeenCalled();
    expect(stripe.subscriptionItems.create).toHaveBeenCalledTimes(1);
    expect(stripe.subscriptionItems.create).toHaveBeenCalledWith(
      {
        subscription: 'sub_existing',
        price: 'price_loyalty',
        quantity: 1,
        proration_behavior: 'create_prorations',
        metadata: {
          storeId: 'store-1',
          service: 'LOYALTY',
        },
      },
      expect.objectContaining({
        idempotencyKey: expect.stringMatching(
          /^store-service:store-1:loyalty:add:/,
        ),
      }),
    );
    expect(prisma.storeServiceSubscription.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          service: 'loyalty',
          status: StoreServiceStatus.pending,
          stripeSubscriptionId: 'sub_existing',
          stripePriceId: 'price_loyalty',
        }),
      }),
    );
    expect(prisma.storeServiceSubscription.update).toHaveBeenCalledWith({
      where: { id: 'service-1' },
      data: {
        stripeSubscriptionId: 'sub_existing',
        stripeSubscriptionItemId: 'si_loyalty',
        stripePriceId: 'price_loyalty',
      },
    });
  });

  it('prevents duplicate active Loyalty add-on requests', async () => {
    prisma.store.findUnique.mockResolvedValue(
      storeFixture({
        storeSubscription: storeSubscriptionFixture({
          status: StoreSubscriptionStatus.active,
          stripeSubscriptionId: 'sub_existing',
        }),
        serviceSubscriptions: [
          {
            id: 'service-1',
            storeId: 'store-1',
            service: 'loyalty',
            status: StoreServiceStatus.active,
            stripeSubscriptionId: 'sub_existing',
            stripeSubscriptionItemId: 'si_loyalty',
            stripePriceId: 'price_loyalty',
          },
        ],
      }),
    );

    await expect(
      service.addStoreService(
        'store-1',
        { service: 'LOYALTY', confirmed: true },
        ownerUser,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(stripe.subscriptionItems.create).not.toHaveBeenCalled();
  });

  it('accepts valid webhook signatures', async () => {
    stripe.webhooks.constructEvent.mockReturnValue(
      stripeEvent('noop.event', {}),
    );

    await expect(
      service.handleWebhook(Buffer.from('{}'), 'valid-signature'),
    ).resolves.toEqual({ received: true });
  });

  it('rejects invalid webhook signatures', async () => {
    stripe.webhooks.constructEvent.mockImplementation(() => {
      throw new Error('invalid signature');
    });

    await expect(
      service.handleWebhook(Buffer.from('{}'), 'bad-signature'),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('links checkout.session.completed identifiers without activating store', async () => {
    stripe.webhooks.constructEvent.mockReturnValue(
      stripeEvent('checkout.session.completed', {
        id: 'cs_test',
        mode: 'subscription',
        customer: 'cus_1',
        subscription: 'sub_1',
        metadata: { storeId: 'store-1', plan: 'PLUS' },
      }),
    );

    await service.handleWebhook(Buffer.from('{}'), 'valid-signature');

    expect(prisma.storeSubscription.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          stripeCustomerId: 'cus_1',
          stripeSubscriptionId: 'sub_1',
          stripeCheckoutSessionId: 'cs_test',
        }),
      }),
    );
    expect(prisma.store.update).not.toHaveBeenCalled();
  });

  it('subscription active events activate the correct store', async () => {
    stripe.webhooks.constructEvent.mockReturnValue(
      stripeEvent(
        'customer.subscription.updated',
        subscriptionFixture('active'),
      ),
    );

    await service.handleWebhook(Buffer.from('{}'), 'valid-signature');

    expect(prisma.store.update).toHaveBeenCalledWith({
      where: { id: 'store-1' },
      data: { isActive: true },
    });
  });

  it('subscription deleted events deactivate the correct store', async () => {
    stripe.webhooks.constructEvent.mockReturnValue(
      stripeEvent(
        'customer.subscription.deleted',
        subscriptionFixture('canceled'),
      ),
    );

    await service.handleWebhook(Buffer.from('{}'), 'valid-signature');

    expect(prisma.store.update).toHaveBeenCalledWith({
      where: { id: 'store-1' },
      data: { isActive: false },
    });
  });

  it('does not process duplicate webhook events twice', async () => {
    prisma.stripeWebhookEvent.findUnique.mockResolvedValue({ id: 'evt_1' });
    stripe.webhooks.constructEvent.mockReturnValue(
      stripeEvent(
        'customer.subscription.updated',
        subscriptionFixture('active'),
      ),
    );

    await service.handleWebhook(Buffer.from('{}'), 'valid-signature');

    expect(prisma.store.update).not.toHaveBeenCalled();
  });

  it('does not activate a missing metadata store', async () => {
    prisma.store.findUnique.mockResolvedValue(null);
    stripe.webhooks.constructEvent.mockReturnValue(
      stripeEvent('customer.subscription.updated', {
        ...subscriptionFixture('active'),
        metadata: { storeId: 'missing-store', plan: 'PLUS' },
      }),
    );

    await service.handleWebhook(Buffer.from('{}'), 'valid-signature');

    expect(prisma.store.update).not.toHaveBeenCalled();
  });
});

function createMockPrisma(): MockPrisma {
  const prisma: MockPrisma = {
    store: {
      findUnique: jest.fn().mockResolvedValue(storeFixture()),
      update: jest.fn(),
      count: jest.fn().mockResolvedValue(1),
    },
    storeSubscription: {
      findUnique: jest.fn().mockResolvedValue(null),
      upsert: jest.fn(),
      update: jest.fn(),
    },
    storeServiceSubscription: {
      upsert: jest.fn().mockResolvedValue({
        id: 'service-1',
        storeId: 'store-1',
        service: 'loyalty',
        status: StoreServiceStatus.pending,
        stripeSubscriptionId: 'sub_existing',
        stripeSubscriptionItemId: 'si_loyalty',
        stripePriceId: 'price_loyalty',
      }),
      update: jest.fn(),
    },
    storeFeature: {
      upsert: jest.fn(),
    },
    stripeWebhookEvent: {
      findUnique: jest.fn().mockResolvedValue(null),
      create: jest.fn(),
    },
    subscription: {
      findFirst: jest.fn().mockResolvedValue({
        id: 'owner-subscription-1',
        plan: SubscriptionPlan.plus,
        status: SubscriptionStatus.active,
        billingCycle: BillingCycle.monthly,
      }),
      update: jest.fn(),
    },
    $transaction: jest.fn((callback: (tx: MockPrisma) => Promise<unknown>) =>
      callback(prisma),
    ),
  };

  return prisma;
}

function createMockStripe(): MockStripe {
  return {
    customers: {
      create: jest.fn().mockResolvedValue({ id: 'cus_1' }),
    },
    checkout: {
      sessions: {
        create: jest.fn().mockResolvedValue({
          id: 'cs_test',
          url: 'https://checkout.stripe.test/session',
          status: 'open',
          expires_at: futureStripeTimestamp(),
        }),
        retrieve: jest.fn(),
      },
    },
    webhooks: {
      constructEvent: jest.fn(),
    },
    subscriptions: {
      retrieve: jest.fn().mockResolvedValue(subscriptionFixture('active')),
    },
    subscriptionItems: {
      create: jest.fn().mockResolvedValue({ id: 'si_loyalty' }),
      del: jest.fn(),
    },
  };
}

function mockConfig(overrides: Record<string, string> = {}) {
  const values: Record<string, string> = {
    STRIPE_SECRET_KEY: 'sk_test_123',
    STRIPE_WEBHOOK_SECRET: 'whsec_123',
    STRIPE_PLUS_PRICE_ID: 'price_plus',
    STRIPE_ADVANCED_PRICE_ID: 'price_advanced',
    STRIPE_LOYALTY_PRICE_ID: 'price_loyalty',
    BACKOFFICE_URL: 'http://localhost:3000',
    ...overrides,
  };

  return {
    get: jest.fn((key: string) => values[key]),
  };
}

function storeFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: 'store-1',
    name: 'Downtown Store',
    address: null,
    businessType: StoreBusinessType.convenience_store,
    isActive: false,
    ownerId: 'owner-1',
    owner: {
      id: 'owner-1',
      email: 'owner@example.com',
      name: 'Owner',
    },
    storeSubscription: null,
    serviceSubscriptions: [],
    ...overrides,
  };
}

function storeSubscriptionFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: 'store-subscription-1',
    storeId: 'store-1',
    plan: SubscriptionPlan.plus,
    status: StoreSubscriptionStatus.pending,
    stripeCustomerId: null,
    stripeSubscriptionId: null,
    stripeCheckoutSessionId: null,
    stripePriceId: 'price_plus',
    checkoutAttemptId: null,
    checkoutIdempotencyKey: null,
    checkoutSessionExpiresAt: null,
    currentPeriodStart: null,
    currentPeriodEnd: null,
    cancelAtPeriodEnd: false,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

function checkoutSessionFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: 'cs_test',
    url: 'https://checkout.stripe.test/session',
    status: 'open',
    expires_at: futureStripeTimestamp(),
    ...overrides,
  };
}

function futureStripeTimestamp() {
  return Math.floor(Date.now() / 1000) + 3600;
}

function pastStripeTimestamp() {
  return Math.floor(Date.now() / 1000) - 3600;
}

function subscriptionFixture(status: string) {
  return {
    id: 'sub_1',
    status,
    customer: 'cus_1',
    metadata: { storeId: 'store-1', plan: 'PLUS' },
    items: { data: [{ price: { id: 'price_plus' } }] },
    current_period_start: 1_700_000_000,
    current_period_end: 1_702_592_000,
    cancel_at_period_end: false,
  };
}

function stripeEvent(type: string, object: unknown) {
  return {
    id: 'evt_1',
    type,
    data: { object },
  };
}

type MockStripe = {
  customers: { create: jest.Mock };
  checkout: { sessions: { create: jest.Mock; retrieve: jest.Mock } };
  webhooks: { constructEvent: jest.Mock };
  subscriptions: { retrieve: jest.Mock };
  subscriptionItems: { create: jest.Mock; del: jest.Mock };
};

type MockPrisma = {
  store: {
    findUnique: jest.Mock;
    update: jest.Mock;
    count: jest.Mock;
  };
  storeSubscription: {
    findUnique: jest.Mock;
    upsert: jest.Mock;
    update: jest.Mock;
  };
  storeServiceSubscription: {
    upsert: jest.Mock;
    update: jest.Mock;
  };
  storeFeature: {
    upsert: jest.Mock;
  };
  stripeWebhookEvent: {
    findUnique: jest.Mock;
    create: jest.Mock;
  };
  subscription: {
    findFirst: jest.Mock;
    update: jest.Mock;
  };
  $transaction: jest.Mock;
};
