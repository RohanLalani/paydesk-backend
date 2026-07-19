import {
  Controller,
  Get,
  Param,
  Query,
  Request,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt.guard';
import { AuthTokenPayload } from '../auth/strategies/jwt.strategy';
import { AuditService } from './audit.service';

@Controller('stores/:storeId/audit-events')
@UseGuards(JwtAuthGuard)
export class AuditController {
  constructor(private readonly auditService: AuditService) {}

  @Get()
  list(
    @Param('storeId') storeId: string,
    @Query() query: Record<string, unknown>,
    @Request() request: { user: AuthTokenPayload },
  ) {
    return this.auditService.list(storeId, request.user, query);
  }

  @Get('product-logs')
  listProductLogs(
    @Param('storeId') storeId: string,
    @Query() query: Record<string, unknown>,
    @Request() request: { user: AuthTokenPayload },
  ) {
    return this.auditService.listProductLogs(storeId, request.user, query);
  }

  @Get(':eventId')
  get(
    @Param('storeId') storeId: string,
    @Param('eventId') eventId: string,
    @Request() request: { user: AuthTokenPayload },
  ) {
    return this.auditService.get(storeId, eventId, request.user);
  }
}
