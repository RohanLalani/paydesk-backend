import { Module } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { PosAccessService } from '../common/pos-access.service';
import { TaxCalculationService } from '../common/tax-calculation.service';
import { PrismaService } from '../prisma.service';
import { RegistersModule } from '../registers/registers.module';
import { ReceiptController } from './receipt.controller';
import { TransactionController } from './transaction.controller';
import { TransactionService } from './transaction.service';

@Module({
  imports: [RegistersModule],
  controllers: [TransactionController, ReceiptController],
  providers: [
    TransactionService,
    AuditService,
    PrismaService,
    PosAccessService,
    TaxCalculationService,
  ],
})
export class TransactionModule {}
