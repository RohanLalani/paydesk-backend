import { Controller, Get, Param, Request, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt.guard';
import { AuthTokenPayload } from '../auth/strategies/jwt.strategy';
import { TransactionService } from './transaction.service';

@Controller('receipt')
@UseGuards(JwtAuthGuard)
export class ReceiptController {
  constructor(private readonly transactionService: TransactionService) {}

  @Get(':receiptNumber')
  findByReceiptNumber(
    @Param('receiptNumber') receiptNumber: string,
    @Request() request: { user: AuthTokenPayload },
  ) {
    return this.transactionService.findReceiptByNumber(
      receiptNumber,
      request.user,
    );
  }
}
