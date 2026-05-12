import { Test, TestingModule } from '@nestjs/testing';
import { GiftCardController } from './gift-card.controller';

describe('GiftCardController', () => {
  let controller: GiftCardController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [GiftCardController],
    }).compile();

    controller = module.get<GiftCardController>(GiftCardController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });
});
