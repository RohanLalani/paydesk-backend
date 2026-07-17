import { Module } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { PosAccessService } from '../common/pos-access.service';
import { PrismaService } from '../prisma.service';
import { RegisterDeviceTokenGuard } from './register-device-token.guard';
import { RegistersController } from './registers.controller';
import { RegistersService } from './registers.service';

@Module({
  controllers: [RegistersController],
  providers: [
    RegistersService,
    AuditService,
    RegisterDeviceTokenGuard,
    PrismaService,
    PosAccessService,
  ],
  exports: [RegistersService],
})
export class RegistersModule {}
