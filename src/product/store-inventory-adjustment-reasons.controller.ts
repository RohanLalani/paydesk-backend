import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Request,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt.guard';
import { AuthTokenPayload } from '../auth/strategies/jwt.strategy';
import { ProductService } from './product.service';

@Controller('stores/:storeId/inventory-adjustment-reasons')
@UseGuards(JwtAuthGuard)
export class StoreInventoryAdjustmentReasonsController {
  constructor(private readonly productService: ProductService) {}

  @Get()
  list(
    @Param('storeId') storeId: string,
    @Query() query: Record<string, unknown>,
    @Request() request: { user: AuthTokenPayload },
  ) {
    return this.productService.listStoreInventoryAdjustmentReasons(
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
    return this.productService.createStoreInventoryAdjustmentReason(
      storeId,
      body,
      request.user,
    );
  }
}
