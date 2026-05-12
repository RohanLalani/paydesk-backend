import { Test, TestingModule } from '@nestjs/testing';
import { OnlineOrderController } from './online-order.controller';

describe('OnlineOrderController', () => {
  let controller: OnlineOrderController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [OnlineOrderController],
    }).compile();

    controller = module.get<OnlineOrderController>(OnlineOrderController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });
});
