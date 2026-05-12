import { Module } from '@nestjs/common';
import { CashManagementService } from './cash-management.service';
import { CashManagementController } from './cash-management.controller';

@Module({
  providers: [CashManagementService],
  controllers: [CashManagementController]
})
export class CashManagementModule {}
