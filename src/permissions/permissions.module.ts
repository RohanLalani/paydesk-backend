import { Module } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { PosAccessService } from '../common/pos-access.service';
import { PrismaService } from '../prisma.service';
import { PermissionsController } from './permissions.controller';
import { PermissionsService } from './permissions.service';

@Module({
  controllers: [PermissionsController],
  providers: [
    PermissionsService,
    AuditService,
    PrismaService,
    PosAccessService,
  ],
})
export class PermissionsModule {}
