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

@Controller('stores/:storeId/payees')
@UseGuards(JwtAuthGuard)
export class StorePayeesController {
  constructor(private readonly purchaseService: PurchaseService) {}

  @Get()
  list(
    @Param('storeId') storeId: string,
    @Query() query: Record<string, unknown>,
    @Request() request: { user: AuthTokenPayload },
  ) {
    return this.purchaseService.listStorePayees(storeId, query, request.user);
  }

  @Post()
  create(
    @Param('storeId') storeId: string,
    @Body() body: Record<string, unknown>,
    @Request() request: { user: AuthTokenPayload },
  ) {
    return this.purchaseService.createStorePayee(storeId, body, request.user);
  }

  @Get(':payeeId')
  get(
    @Param('storeId') storeId: string,
    @Param('payeeId') payeeId: string,
    @Request() request: { user: AuthTokenPayload },
  ) {
    return this.purchaseService.getStorePayee(storeId, payeeId, request.user);
  }

  @Patch(':payeeId')
  update(
    @Param('storeId') storeId: string,
    @Param('payeeId') payeeId: string,
    @Body() body: Record<string, unknown>,
    @Request() request: { user: AuthTokenPayload },
  ) {
    return this.purchaseService.updateStorePayee(
      storeId,
      payeeId,
      body,
      request.user,
    );
  }
}
