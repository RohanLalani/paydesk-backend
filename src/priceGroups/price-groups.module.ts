import { Module } from '@nestjs/common';
import { PosAccessService } from '../common/pos-access.service';
import { PrismaService } from '../prisma.service';
import { PriceGroupController } from './price-groups.controller';
import { PriceGroupService } from './price-groups.service';

@Module({
  controllers: [PriceGroupController],
  providers: [PriceGroupService, PrismaService, PosAccessService],
})
export class PriceGroupModule {}
