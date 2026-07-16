import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Request,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt.guard';
import { AuthTokenPayload } from '../auth/strategies/jwt.strategy';
import { ProductService } from './product.service';

@Controller('stores/:storeId/categories')
@UseGuards(JwtAuthGuard)
export class StoreCategoriesController {
  constructor(private readonly productService: ProductService) {}

  @Get()
  list(
    @Param('storeId') storeId: string,
    @Query() query: Record<string, unknown>,
    @Request() request: { user: AuthTokenPayload },
  ) {
    return this.productService.listStoreCategories(
      storeId,
      request.user,
      query,
    );
  }

  @Post()
  create(
    @Param('storeId') storeId: string,
    @Body() body: Record<string, unknown>,
    @Request() request: { user: AuthTokenPayload },
  ) {
    return this.productService.createStoreCategory(storeId, body, request.user);
  }

  @Get(':categoryId')
  detail(
    @Param('storeId') storeId: string,
    @Param('categoryId') categoryId: string,
    @Request() request: { user: AuthTokenPayload },
  ) {
    return this.productService.getStoreCategory(
      storeId,
      categoryId,
      request.user,
    );
  }

  @Patch(':categoryId')
  update(
    @Param('storeId') storeId: string,
    @Param('categoryId') categoryId: string,
    @Body() body: Record<string, unknown>,
    @Request() request: { user: AuthTokenPayload },
  ) {
    return this.productService.updateStoreCategory(
      storeId,
      categoryId,
      body,
      request.user,
    );
  }

  @Get(':categoryId/products')
  products(
    @Param('storeId') storeId: string,
    @Param('categoryId') categoryId: string,
    @Query() query: Record<string, unknown>,
    @Request() request: { user: AuthTokenPayload },
  ) {
    return this.productService.listStoreCategoryProducts(
      storeId,
      categoryId,
      request.user,
      query,
    );
  }
}
