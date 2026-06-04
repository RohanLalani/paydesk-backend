import { Controller, Get, Param } from '@nestjs/common';
import { TransactionService } from './transaction.service';

@Controller('receipt')
export class ReceiptController {
  constructor(private readonly transactionService: TransactionService) {}

  @Get(':receiptNumber')
  findByReceiptNumber(@Param('receiptNumber') receiptNumber: string) {
    return this.transactionService.findReceiptByNumberWithoutUser(
      receiptNumber,
    );
  }
}
