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
        }),
      }),
    );
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
        }),
      },
    },
    webhooks: {
      constructEvent: jest.fn(),
    },
    subscriptions: {
      retrieve: jest.fn().mockResolvedValue(subscriptionFixture('active')),
    },
  };
}

function mockConfig() {
  const values: Record<string, string> = {
    STRIPE_SECRET_KEY: 'sk_test_123',
    STRIPE_WEBHOOK_SECRET: 'whsec_123',
    STRIPE_PLUS_PRICE_ID: 'price_plus',
    STRIPE_ADVANCED_PRICE_ID: 'price_advanced',
    BACKOFFICE_URL: 'http://localhost:3000',
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
    ...overrides,
  };
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
  checkout: { sessions: { create: jest.Mock } };
  webhooks: { constructEvent: jest.Mock };
  subscriptions: { retrieve: jest.Mock };
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
