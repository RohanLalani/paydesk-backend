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
import { PurchaseService } from './purchase.service';

@Controller('stores/:storeId/purchases')
@UseGuards(JwtAuthGuard)
export class StorePurchasesController {
  constructor(private readonly purchaseService: PurchaseService) {}

  @Get()
  list(
    @Param('storeId') storeId: string,
    @Query() query: Record<string, unknown>,
    @Request() request: { user: AuthTokenPayload },
  ) {
    return this.purchaseService.listStorePurchases(
      storeId,
      query,
      request.user,
    );
  }

  @Post()
  create(
    @Param('storeId') storeId: string,
    @Body() body: Record<string, unknown>,
    @Request() request: { user: AuthTokenPayload },
  ) {
    return this.purchaseService.createStorePurchase(
      storeId,
      body,
      request.user,
    );
  }

  @Get(':purchaseId')
  get(
    @Param('storeId') storeId: string,
    @Param('purchaseId') purchaseId: string,
    @Request() request: { user: AuthTokenPayload },
  ) {
    return this.purchaseService.getStorePurchase(
      storeId,
      purchaseId,
      request.user,
    );
  }

  @Patch(':purchaseId')
  update(
    @Param('storeId') storeId: string,
    @Param('purchaseId') purchaseId: string,
    @Body() body: Record<string, unknown>,
    @Request() request: { user: AuthTokenPayload },
  ) {
    return this.purchaseService.updateStorePurchase(
      storeId,
      purchaseId,
      body,
      request.user,
    );
  }
}
