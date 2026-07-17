import { Module } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { PosAccessService } from '../common/pos-access.service';
import { TaxCalculationService } from '../common/tax-calculation.service';
import { PrismaService } from '../prisma.service';
import { PriceGroupMismatchRefreshService } from './price-group-mismatch-refresh.service';
import { ProductController } from './product.controller';
import { ProductService } from './product.service';
import { StoreCategoriesController } from './store-categories.controller';
import { StoreDepartmentsController } from './store-departments.controller';
import { StorePriceGroupsController } from './store-price-groups.controller';
import { StoreProductsController } from './store-products.controller';
import { StoreTaxesController } from './store-taxes.controller';

@Module({
  controllers: [
    ProductController,
    StoreCategoriesController,
    StoreDepartmentsController,
    StorePriceGroupsController,
    StoreProductsController,
    StoreTaxesController,
  ],
  providers: [
    ProductService,
    PriceGroupMismatchRefreshService,
    TaxCalculationService,
    AuditService,
    PrismaService,
    PosAccessService,
  ],
})
export class ProductModule {}
