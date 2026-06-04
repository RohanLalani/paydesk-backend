import {
  Body,
  Controller,
  Get,
  Param,
  Put,
  Request,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt.guard';
import { AuthTokenPayload } from '../auth/strategies/jwt.strategy';
import { PermissionsService } from './permissions.service';

@Controller('permissions')
@UseGuards(JwtAuthGuard)
export class PermissionsController {
  constructor(private readonly permissionsService: PermissionsService) {}

  @Get('keys')
  keys() {
    return this.permissionsService.keys();
  }

  @Get('store/:storeId/staff')
  listStaffPermissions(
    @Param('storeId') storeId: string,
    @Request() request: { user: AuthTokenPayload },
  ) {
    return this.permissionsService.listStaffPermissions(storeId, request.user);
  }

  @Get('store/:storeId/staff/:staffId')
  getStaffPermissions(
    @Param('storeId') storeId: string,
    @Param('staffId') staffId: string,
    @Request() request: { user: AuthTokenPayload },
  ) {
    return this.permissionsService.getStaffPermissions(
      storeId,
      staffId,
      request.user,
    );
  }

  @Put('store/:storeId/staff/:staffId')
  updateStaffPermissions(
    @Param('storeId') storeId: string,
    @Param('staffId') staffId: string,
    @Body() body: Record<string, unknown>,
    @Request() request: { user: AuthTokenPayload },
  ) {
    return this.permissionsService.updateStaffPermissions(
      storeId,
      staffId,
      body,
      request.user,
    );
  }
}
