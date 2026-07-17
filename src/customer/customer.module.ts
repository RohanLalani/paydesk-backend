import { Module } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { PosAccessService } from '../common/pos-access.service';
import { PrismaService } from '../prisma.service';
import { CustomerController } from './customer.controller';
import { CustomerService } from './customer.service';

@Module({
  controllers: [CustomerController],
  providers: [CustomerService, AuditService, PrismaService, PosAccessService],
})
export class CustomerModule {}
