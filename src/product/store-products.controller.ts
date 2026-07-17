import {
  Controller,
  Get,
  Param,
  Query,
  Request,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt.guard';
import { AuthTokenPayload } from '../auth/strategies/jwt.strategy';
import { ProductService } from './product.service';

@Controller('stores/:storeId')
@UseGuards(JwtAuthGuard)
export class StoreProductsController {
  constructor(private readonly productService: ProductService) {}

  @Get('pos/categories')
  listPosCategories(
    @Param('storeId') storeId: string,
    @Request() request: { user: AuthTokenPayload },
  ) {
    return this.productService.listPosCategories(storeId, request.user);
  }

  @Get('products/next-product-number')
  nextProductNumber(
    @Param('storeId') storeId: string,
    @Request() request: { user: AuthTokenPayload },
  ) {
    return this.productService.getNextProductNumber(storeId, request.user);
  }

  @Get('products')
  listStoreProducts(
    @Param('storeId') storeId: string,
    @Query() query: Record<string, unknown>,
    @Request() request: { user: AuthTokenPayload },
  ) {
    return this.productService.listStoreProducts(storeId, query, request.user);
  }

  @Get('inventory/overview')
  listInventoryOverview(
    @Param('storeId') storeId: string,
    @Query() query: Record<string, unknown>,
    @Request() request: { user: AuthTokenPayload },
  ) {
    return this.productService.listInventoryOverview(
      storeId,
      query,
      request.user,
    );
  }

  @Get('products/product-number/:productNumber')
  findByProductNumber(
    @Param('storeId') storeId: string,
    @Param('productNumber') productNumber: string,
    @Request() request: { user: AuthTokenPayload },
  ) {
    return this.productService.findByProductNumber(
      storeId,
      productNumber,
      request.user,
    );
  }

  @Get('products/:productId')
  findStoreProductById(
    @Param('storeId') storeId: string,
    @Param('productId') productId: string,
    @Request() request: { user: AuthTokenPayload },
  ) {
    return this.productService.findStoreProductById(
      storeId,
      productId,
      request.user,
    );
  }
}
