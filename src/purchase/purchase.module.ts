import { Module } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { PosAccessService } from '../common/pos-access.service';
import { PrismaService } from '../prisma.service';
import { PurchaseService } from './purchase.service';
import { StorePayeesController } from './store-payees.controller';
import { StorePurchasesController } from './store-purchases.controller';
import { VendorOrdersController } from './vendor-orders.controller';
import { VendorOrdersService } from './vendor-orders.service';

@Module({
  controllers: [
    StorePayeesController,
    StorePurchasesController,
    VendorOrdersController,
  ],
  providers: [
    PurchaseService,
    VendorOrdersService,
    AuditService,
    PrismaService,
    PosAccessService,
  ],
})
export class PurchaseModule {}
