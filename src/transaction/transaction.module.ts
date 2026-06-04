import { Module } from '@nestjs/common';
import { PosAccessService } from '../common/pos-access.service';
import { PrismaService } from '../prisma.service';
import { RegistersModule } from '../registers/registers.module';
import { ReceiptController } from './receipt.controller';
import { TransactionController } from './transaction.controller';
import { TransactionService } from './transaction.service';

@Module({
  imports: [RegistersModule],
  controllers: [TransactionController, ReceiptController],
  providers: [TransactionService, PrismaService, PosAccessService],
})
export class TransactionModule {}
