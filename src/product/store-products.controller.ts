import { Controller, Get, Param, Request, UseGuards } from '@nestjs/common';
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
}
