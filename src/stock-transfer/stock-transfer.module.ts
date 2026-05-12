import { Module } from '@nestjs/common';
import { StockTransferService } from './stock-transfer.service';
import { StockTransferController } from './stock-transfer.controller';

@Module({
  providers: [StockTransferService],
  controllers: [StockTransferController]
})
export class StockTransferModule {}
