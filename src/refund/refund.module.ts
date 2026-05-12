import { Module } from '@nestjs/common';
import { RefundService } from './refund.service';
import { RefundController } from './refund.controller';

@Module({
  providers: [RefundService],
  controllers: [RefundController]
})
export class RefundModule {}
