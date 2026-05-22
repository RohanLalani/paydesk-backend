import { Test, TestingModule } from '@nestjs/testing';
import { AuthTokenPayload } from '../auth/strategies/jwt.strategy';
import { CustomerController } from './customer.controller';
import { CustomerService } from './customer.service';

describe('CustomerController', () => {
  let controller: CustomerController;
  let service: MockCustomerService;

  const user: AuthTokenPayload = {
    accountId: 'owner-1',
    staffId: 'staff-owner-1',
    role: 'owner',
    type: 'owner',
  };
  const request = { user };

  beforeEach(async () => {
    service = {
      create: jest.fn().mockResolvedValue({ id: 'customer-1' }),
      findByPhone: jest.fn().mockResolvedValue({ id: 'customer-1' }),
      listByStore: jest.fn().mockResolvedValue([{ id: 'customer-1' }]),
      createTier: jest.fn().mockResolvedValue({ id: 'tier-1' }),
      createTierRule: jest.fn().mockResolvedValue({ id: 'tier-rule-1' }),
      getPurchases: jest.fn().mockResolvedValue([{ id: 'purchase-1' }]),
      recalculateCustomerTier: jest.fn().mockResolvedValue({
        id: 'customer-1',
        tier: 'Gold',
      }),
      findByCustomerNumber: jest.fn().mockResolvedValue({ id: 'customer-1' }),
      update: jest.fn().mockResolvedValue({ id: 'customer-1' }),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [CustomerController],
      providers: [
        {
          provide: CustomerService,
          useValue: service,
        },
      ],
    }).compile();

    controller = module.get<CustomerController>(CustomerController);
  });

  it('creates a customer', async () => {
    const body = { firstName: 'Ada' };

    await expect(controller.create(body, request)).resolves.toEqual({
      id: 'customer-1',
    });
    expect(service.create).toHaveBeenCalledWith(body, user);
  });

  it('finds a customer by phone', async () => {
    await expect(
      controller.findByPhone('5551112222', request),
    ).resolves.toEqual({ id: 'customer-1' });
    expect(service.findByPhone).toHaveBeenCalledWith('5551112222', user);
  });

  it('lists customers for a store', async () => {
    await expect(controller.listByStore('store-1', request)).resolves.toEqual([
      { id: 'customer-1' },
    ]);
    expect(service.listByStore).toHaveBeenCalledWith('store-1', user);
  });

  it('creates a tier rule', async () => {
    const body = { storeId: 'store-1', name: 'Gold' };

    await expect(controller.createTierRule(body, request)).resolves.toEqual({
      id: 'tier-rule-1',
    });
    expect(service.createTierRule).toHaveBeenCalledWith(body, user);
  });

  it('creates a customer tier', async () => {
    const body = {
      storeId: 'store-1',
      name: 'Gold',
      discountModel: 'ORDER_PERCENTAGE',
      discountValue: 10,
    };

    await expect(controller.createTier(body, request)).resolves.toEqual({
      id: 'tier-1',
    });
    expect(service.createTier).toHaveBeenCalledWith(body, user);
  });

  it('returns customer purchases', async () => {
    await expect(controller.purchases('customer-1', request)).resolves.toEqual([
      { id: 'purchase-1' },
    ]);
    expect(service.getPurchases).toHaveBeenCalledWith('customer-1', user);
  });

  it('recalculates customer tier', async () => {
    const body = { storeId: 'store-1' };

    await expect(
      controller.recalculateTier('customer-1', body, request),
    ).resolves.toEqual({
      id: 'customer-1',
      tier: 'Gold',
    });
    expect(service.recalculateCustomerTier).toHaveBeenCalledWith(
      'customer-1',
      body,
      user,
    );
  });

  it('finds a customer by customer number', async () => {
    await expect(
      controller.findByCustomerNumber('123456789012345678', request),
    ).resolves.toEqual({ id: 'customer-1' });
    expect(service.findByCustomerNumber).toHaveBeenCalledWith(
      '123456789012345678',
      user,
    );
  });

  it('updates a customer', async () => {
    const body = { firstName: 'Grace' };

    await expect(
      controller.update('customer-1', body, request),
    ).resolves.toEqual({ id: 'customer-1' });
    expect(service.update).toHaveBeenCalledWith('customer-1', body, user);
  });
});

type MockCustomerService = Record<
  keyof Pick<
    CustomerService,
    | 'create'
    | 'findByPhone'
    | 'listByStore'
    | 'createTier'
    | 'createTierRule'
    | 'getPurchases'
    | 'recalculateCustomerTier'
    | 'findByCustomerNumber'
    | 'update'
  >,
  jest.Mock
>;
