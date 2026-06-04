import { Module } from '@nestjs/common';
import { PosAccessService } from '../common/pos-access.service';
import { PrismaService } from '../prisma.service';
import { RegisterDeviceTokenGuard } from './register-device-token.guard';
import { RegistersController } from './registers.controller';
import { RegistersService } from './registers.service';

@Module({
  controllers: [RegistersController],
  providers: [
    RegistersService,
    RegisterDeviceTokenGuard,
    PrismaService,
    PosAccessService,
  ],
  exports: [RegistersService],
})
export class RegistersModule {}
