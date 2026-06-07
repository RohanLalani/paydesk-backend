import { Controller, Get, Param, Query, Request, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt.guard';
import { AuthTokenPayload } from '../auth/strategies/jwt.strategy';
import { DashboardService, DashboardRange } from './dashboard.service';

@Controller('dashboard')
@UseGuards(JwtAuthGuard)
export class DashboardController {
  constructor(private readonly dashboardService: DashboardService) {}

  @Get('store/:storeId/summary')
  getStoreSummary(
    @Param('storeId') storeId: string,
    @Query('range') range: DashboardRange | undefined,
    @Request() request: { user: AuthTokenPayload },
  ) {
    return this.dashboardService.getStoreSummary(
      storeId,
      request.user,
      range,
    );
  }
}

