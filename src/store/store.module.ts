import { Module } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { PosAccessService } from '../common/pos-access.service';
import { PrismaService } from '../prisma.service';
import { StoreController } from './store.controller';
import { StoreService } from './store.service';

@Module({
  controllers: [StoreController],
  providers: [StoreService, AuditService, PrismaService, PosAccessService],
  exports: [StoreService],
})
export class StoreModule {}
