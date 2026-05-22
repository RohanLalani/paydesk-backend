import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AuthModule } from './auth/auth.module';
import { CustomerModule } from './customer/customer.module';
import { DepartmentModule } from './department/department.module';
import { PriceGroupModule } from './priceGroups/price-groups.module';
import { ProductModule } from './product/product.module';
import { ProductCategoryModule } from './productCategory/product-category.module';
import { StoreModule } from './store/store.module';
import { TaxModule } from './tax/tax.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
    }),
    ThrottlerModule.forRoot([
      {
        ttl: 60_000,
        limit: 100,
      },
    ]),
    AuthModule,
    CustomerModule,
    StoreModule,
    ProductModule,
    DepartmentModule,
    PriceGroupModule,
    ProductCategoryModule,
    TaxModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    {
      provide: APP_GUARD,
      useClass: ThrottlerGuard,
    },
  ],
})
export class AppModule {}
