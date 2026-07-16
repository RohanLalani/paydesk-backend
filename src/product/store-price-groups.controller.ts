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

@Controller('stores/:storeId/price-groups')
@UseGuards(JwtAuthGuard)
export class StorePriceGroupsController {
  constructor(private readonly productService: ProductService) {}

  @Get()
  list(
    @Param('storeId') storeId: string,
    @Query() query: Record<string, unknown>,
    @Request() request: { user: AuthTokenPayload },
  ) {
    return this.productService.listStorePriceGroups(
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
    return this.productService.createStorePriceGroup(
      storeId,
      body,
      request.user,
    );
  }

  @Get(':priceGroupId')
  detail(
    @Param('storeId') storeId: string,
    @Param('priceGroupId') priceGroupId: string,
    @Request() request: { user: AuthTokenPayload },
  ) {
    return this.productService.getStorePriceGroup(
      storeId,
      priceGroupId,
      request.user,
    );
  }

  @Patch(':priceGroupId')
  update(
    @Param('storeId') storeId: string,
    @Param('priceGroupId') priceGroupId: string,
    @Body() body: Record<string, unknown>,
    @Request() request: { user: AuthTokenPayload },
  ) {
    return this.productService.updateStorePriceGroup(
      storeId,
      priceGroupId,
      body,
      request.user,
    );
  }

  @Get(':priceGroupId/products')
  products(
    @Param('storeId') storeId: string,
    @Param('priceGroupId') priceGroupId: string,
    @Query() query: Record<string, unknown>,
    @Request() request: { user: AuthTokenPayload },
  ) {
    return this.productService.listStorePriceGroupProducts(
      storeId,
      priceGroupId,
      request.user,
      query,
    );
  }
}
