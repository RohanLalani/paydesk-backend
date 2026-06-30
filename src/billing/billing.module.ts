import { Module } from '@nestjs/common';
import { StoreModule } from '../store/store.module';
import { BillingController } from './billing.controller';

@Module({
  imports: [StoreModule],
  controllers: [BillingController],
})
export class BillingModule {}
