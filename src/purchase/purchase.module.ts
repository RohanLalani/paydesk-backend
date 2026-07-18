import { Module } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { PosAccessService } from '../common/pos-access.service';
import { PrismaService } from '../prisma.service';
import { PurchaseService } from './purchase.service';
import { StorePayeesController } from './store-payees.controller';
import { StorePurchasesController } from './store-purchases.controller';

@Module({
  controllers: [StorePayeesController, StorePurchasesController],
  providers: [PurchaseService, AuditService, PrismaService, PosAccessService],
})
export class PurchaseModule {}
