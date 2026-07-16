import { Module } from '@nestjs/common';
import { PosAccessService } from '../common/pos-access.service';
import { PrismaService } from '../prisma.service';
import { ProductController } from './product.controller';
import { ProductService } from './product.service';
import { StoreDepartmentsController } from './store-departments.controller';

@Module({
  controllers: [ProductController, StoreDepartmentsController],
  providers: [ProductService, PrismaService, PosAccessService],
})
export class ProductModule {}
