import { Test, TestingModule } from '@nestjs/testing';
import { CashManagementController } from './cash-management.controller';

describe('CashManagementController', () => {
  let controller: CashManagementController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [CashManagementController],
    }).compile();

    controller = module.get<CashManagementController>(CashManagementController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });
});
