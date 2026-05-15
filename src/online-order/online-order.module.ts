import { Module } from '@nestjs/common';

import { OnlineOrderController } from './online-order.controller';
import { OnlineOrderService } from './online-order.service';

@Module({
  controllers: [OnlineOrderController],
  providers: [OnlineOrderService],
})
export class OnlineOrderModule {}