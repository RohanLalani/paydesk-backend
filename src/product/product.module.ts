import { Module } from '@nestjs/common';
import { PosAccessService } from '../common/pos-access.service';
import { PrismaService } from '../prisma.service';
import { PriceGroupMismatchRefreshService } from './price-group-mismatch-refresh.service';
import { ProductController } from './product.controller';
import { ProductService } from './product.service';
import { StoreDepartmentsController } from './store-departments.controller';
import { StorePriceGroupsController } from './store-price-groups.controller';

@Module({
  controllers: [
    ProductController,
    StoreDepartmentsController,
    StorePriceGroupsController,
  ],
  providers: [
    ProductService,
    PriceGroupMismatchRefreshService,
    PrismaService,
    PosAccessService,
  ],
})
export class ProductModule {}
