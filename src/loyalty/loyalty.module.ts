import { Module } from '@nestjs/common';
import { PosAccessService } from '../common/pos-access.service';
import { PrismaService } from '../prisma.service';
import { LoyaltyController } from './loyalty.controller';
import { LoyaltyService } from './loyalty.service';

@Module({
  controllers: [LoyaltyController],
  providers: [LoyaltyService, PrismaService, PosAccessService],
})
export class LoyaltyModule {}
