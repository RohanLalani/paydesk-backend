import {
  Body,
  Controller,
  Get,
  Patch,
  Request,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt.guard';
import { AuthTokenPayload } from '../auth/strategies/jwt.strategy';
import { StoreService } from '../store/store.service';

@Controller('billing')
@UseGuards(JwtAuthGuard)
export class BillingController {
  constructor(private readonly storeService: StoreService) {}

  @Get('subscription')
  getSubscription(@Request() request: { user: AuthTokenPayload }) {
    return this.storeService.getOwnerSubscription(request.user);
  }

  @Patch('subscription/plan')
  updateSubscriptionPlan(
    @Body() body: Record<string, unknown>,
    @Request() request: { user: AuthTokenPayload },
  ) {
    return this.storeService.updateSubscriptionPlan(body, request.user);
  }
}
