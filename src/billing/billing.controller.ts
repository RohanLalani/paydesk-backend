import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Patch,
  Post,
  Req,
  Request,
  UseGuards,
} from '@nestjs/common';
import { Request as ExpressRequest } from 'express';
import { JwtAuthGuard } from '../auth/guards/jwt.guard';
import { AuthTokenPayload } from '../auth/strategies/jwt.strategy';
import { StoreService } from '../store/store.service';
import { BillingService } from './billing.service';

@Controller('billing')
export class BillingController {
  constructor(
    private readonly storeService: StoreService,
    private readonly billingService: BillingService,
  ) {}

  @Get('subscription')
  @UseGuards(JwtAuthGuard)
  getSubscription(@Request() request: { user: AuthTokenPayload }) {
    return this.storeService.getOwnerSubscription(request.user);
  }

  @Patch('subscription/plan')
  @UseGuards(JwtAuthGuard)
  updateSubscriptionPlan(
    @Body() body: Record<string, unknown>,
    @Request() request: { user: AuthTokenPayload },
  ) {
    return this.storeService.updateSubscriptionPlan(body, request.user);
  }

  @Post('checkout-session')
  @UseGuards(JwtAuthGuard)
  createCheckoutSession(
    @Body() body: Record<string, unknown>,
    @Request() request: { user: AuthTokenPayload },
  ) {
    return this.billingService.createCheckoutSession(body, request.user);
  }

  @Post('webhook')
  @HttpCode(200)
  handleWebhook(
    @Req() request: ExpressRequest & { body: Buffer },
    @Headers('stripe-signature') signature?: string,
  ) {
    const rawBody = Buffer.isBuffer(request.body)
      ? request.body
      : Buffer.from('');

    return this.billingService.handleWebhook(rawBody, signature);
  }
}
