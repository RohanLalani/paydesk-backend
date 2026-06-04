import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Request,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt.guard';
import { AuthTokenPayload } from '../auth/strategies/jwt.strategy';
import { RegisterDeviceTokenGuard } from './register-device-token.guard';
import type { RegisterDeviceRequest } from './registers.service';
import { RegistersService } from './registers.service';

@Controller()
export class RegistersController {
  constructor(private readonly registersService: RegistersService) {}

  @Post('stores/:storeId/registers')
  @UseGuards(JwtAuthGuard)
  create(
    @Param('storeId') storeId: string,
    @Body() body: Record<string, unknown>,
    @Request() request: { user: AuthTokenPayload },
  ) {
    return this.registersService.create(storeId, body, request.user);
  }

  @Get('stores/:storeId/registers')
  @UseGuards(JwtAuthGuard)
  list(
    @Param('storeId') storeId: string,
    @Request() request: { user: AuthTokenPayload },
  ) {
    return this.registersService.list(storeId, request.user);
  }

  @Get('stores/:storeId/registers/:registerId')
  @UseGuards(JwtAuthGuard)
  findOne(
    @Param('storeId') storeId: string,
    @Param('registerId') registerId: string,
    @Request() request: { user: AuthTokenPayload },
  ) {
    return this.registersService.findOne(storeId, registerId, request.user);
  }

  @Patch('stores/:storeId/registers/:registerId')
  @UseGuards(JwtAuthGuard)
  update(
    @Param('storeId') storeId: string,
    @Param('registerId') registerId: string,
    @Body() body: Record<string, unknown>,
    @Request() request: { user: AuthTokenPayload },
  ) {
    return this.registersService.update(
      storeId,
      registerId,
      body,
      request.user,
    );
  }

  @Delete('stores/:storeId/registers/:registerId')
  @UseGuards(JwtAuthGuard)
  revoke(
    @Param('storeId') storeId: string,
    @Param('registerId') registerId: string,
    @Request() request: { user: AuthTokenPayload },
  ) {
    return this.registersService.revokeRegister(
      storeId,
      registerId,
      request.user,
    );
  }

  @Post('stores/:storeId/registers/:registerId/activation-code')
  @UseGuards(JwtAuthGuard)
  createActivationCode(
    @Param('storeId') storeId: string,
    @Param('registerId') registerId: string,
    @Request() request: { user: AuthTokenPayload },
  ) {
    return this.registersService.createActivationCode(
      storeId,
      registerId,
      request.user,
    );
  }

  @Post('stores/:storeId/registers/:registerId/devices/:deviceId/revoke')
  @UseGuards(JwtAuthGuard)
  revokeDevice(
    @Param('storeId') storeId: string,
    @Param('registerId') registerId: string,
    @Param('deviceId') deviceId: string,
    @Request() request: { user: AuthTokenPayload },
  ) {
    return this.registersService.revokeDevice(
      storeId,
      registerId,
      deviceId,
      request.user,
    );
  }

  @Post('registers/activate')
  activate(@Body() body: Record<string, unknown>) {
    return this.registersService.activate(body);
  }

  @Post('registers/heartbeat')
  @UseGuards(RegisterDeviceTokenGuard)
  heartbeat(@Request() request: RegisterDeviceRequest) {
    return this.registersService.heartbeat(request.registerContext);
  }
}
