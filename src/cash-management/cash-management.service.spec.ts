import { Test, TestingModule } from '@nestjs/testing';
import { CashManagementService } from './cash-management.service';

describe('CashManagementService', () => {
  let service: CashManagementService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [CashManagementService],
    }).compile();

    service = module.get<CashManagementService>(CashManagementService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
