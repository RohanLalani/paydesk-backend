import { Module } from '@nestjs/common';
import { GiftCardService } from './gift-card.service';
import { GiftCardController } from './gift-card.controller';

@Module({
  providers: [GiftCardService],
  controllers: [GiftCardController]
})
export class GiftCardModule {}
