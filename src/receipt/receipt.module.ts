import { Module } from '@nestjs/common';
import { ReceiptService } from './receipt.service';
import { ReceiptController } from './receipt.controller';

@Module({
  providers: [ReceiptService],
  controllers: [ReceiptController]
})
export class ReceiptModule {}
