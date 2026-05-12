import { Module } from '@nestjs/common';
import { PurchaseOrderService } from './purchase-order.service';
import { PurchaseOrderController } from './purchase-order.controller';

@Module({
  providers: [PurchaseOrderService],
  controllers: [PurchaseOrderController]
})
export class PurchaseOrderModule {}
