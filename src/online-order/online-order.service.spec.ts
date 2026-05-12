import { Test, TestingModule } from '@nestjs/testing';
import { OnlineOrderService } from './online-order.service';

describe('OnlineOrderService', () => {
  let service: OnlineOrderService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [OnlineOrderService],
    }).compile();

    service = module.get<OnlineOrderService>(OnlineOrderService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
