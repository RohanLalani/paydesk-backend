import { Module } from '@nestjs/common';
import { PosAccessService } from '../common/pos-access.service';
import { PrismaService } from '../prisma.service';
import { TransactionController } from './transaction.controller';
import { TransactionService } from './transaction.service';

@Module({
  controllers: [TransactionController],
  providers: [TransactionService, PrismaService, PosAccessService],
})
export class TransactionModule {}
