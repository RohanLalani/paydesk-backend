import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  Post,
  Query,
  Request,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt.guard';
import { AuthTokenPayload } from '../auth/strategies/jwt.strategy';
import { TransactionService } from './transaction.service';

@Controller('transaction')
@UseGuards(JwtAuthGuard)
export class TransactionController {
  constructor(private readonly transactionService: TransactionService) {}

  @Post('cart/validate')
  validateCart(
    @Body() body: Record<string, unknown>,
    @Request() request: { user: AuthTokenPayload },
  ) {
    return this.transactionService.validateCart(body, request.user);
  }

  @Post('checkout')
  checkout(
    @Body() body: Record<string, unknown>,
    @Headers('x-register-token') registerToken: string | undefined,
    @Request() request: { user: AuthTokenPayload },
  ) {
    return this.transactionService.checkout(body, request.user, registerToken);
  }

  @Get('store/:storeId')
  listByStore(
    @Param('storeId') storeId: string,
    @Query() query: Record<string, unknown>,
    @Request() request: { user: AuthTokenPayload },
  ) {
    return this.transactionService.listByStore(storeId, request.user, query);
  }

  @Get('receipt/:receiptNumber')
  findReceiptByNumber(
    @Param('receiptNumber') receiptNumber: string,
    @Request() request: { user: AuthTokenPayload },
  ) {
    return this.transactionService.findReceiptByNumber(
      receiptNumber,
      request.user,
    );
  }

  @Get(':transactionId/receipt')
  findReceipt(
    @Param('transactionId') transactionId: string,
    @Request() request: { user: AuthTokenPayload },
  ) {
    return this.transactionService.findReceipt(transactionId, request.user);
  }

  @Get(':transactionId')
  findOne(
    @Param('transactionId') transactionId: string,
    @Request() request: { user: AuthTokenPayload },
  ) {
    return this.transactionService.findOne(transactionId, request.user);
  }
}
