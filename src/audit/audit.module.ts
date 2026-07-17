import { Module } from '@nestjs/common';
import { PosAccessService } from '../common/pos-access.service';
import { PrismaService } from '../prisma.service';
import { AuditController } from './audit.controller';
import { AuditService } from './audit.service';

@Module({
  controllers: [AuditController],
  providers: [AuditService, PrismaService, PosAccessService],
  exports: [AuditService],
})
export class AuditModule {}
