import { Module } from '@nestjs/common';
import { PosAccessService } from '../common/pos-access.service';
import { TaxCalculationService } from '../common/tax-calculation.service';
import { PrismaService } from '../prisma.service';
import { CartController } from './cart.controller';
import { CartService } from './cart.service';

@Module({
  controllers: [CartController],
  providers: [
    CartService,
    PrismaService,
    PosAccessService,
    TaxCalculationService,
  ],
})
export class CartModule {}
