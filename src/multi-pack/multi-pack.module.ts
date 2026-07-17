import { Module } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { PosAccessService } from '../common/pos-access.service';
import { PrismaService } from '../prisma.service';
import { MultiPackController } from './multi-pack.controller';
import { MultiPackService } from './multi-pack.service';

@Module({
  controllers: [MultiPackController],
  providers: [MultiPackService, AuditService, PrismaService, PosAccessService],
})
export class MultiPackModule {}
