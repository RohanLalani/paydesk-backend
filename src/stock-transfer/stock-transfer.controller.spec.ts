import { Test, TestingModule } from '@nestjs/testing';
import { StockTransferController } from './stock-transfer.controller';

describe('StockTransferController', () => {
  let controller: StockTransferController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [StockTransferController],
    }).compile();

    controller = module.get<StockTransferController>(StockTransferController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });
});
