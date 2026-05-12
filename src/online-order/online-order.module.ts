import { Module } from '@nestjs/common';
import { OnlineOrderService } from './online-order.service';
import { OnlineOrderController } from './online-order.controller';
import { OnlineOrderController } from './online-order.controller';
import { OnlineOrderService } from './online-order.service';

@Module({
  providers: [OnlineOrderService],
  controllers: [OnlineOrderController]
})
export class OnlineOrderModule {}
