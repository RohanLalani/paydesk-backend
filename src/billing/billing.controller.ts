import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpException,
  HttpCode,
  HttpStatus,
  InternalServerErrorException,
  Logger,
  Param,
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
  private readonly logger = new Logger(BillingController.name);

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

  @Get('store-activation-status/:storeId')
  @UseGuards(JwtAuthGuard)
  getStoreActivationStatus(
    @Param('storeId') storeId: string,
    @Request() request: { user: AuthTokenPayload },
  ) {
    return this.billingService.getStoreActivationStatus(storeId, request.user);
  }

  @Get('stores/:storeId/summary')
  @UseGuards(JwtAuthGuard)
  getStoreBillingSummary(
    @Param('storeId') storeId: string,
    @Request() request: { user: AuthTokenPayload },
  ) {
    return this.billingService.getStoreBillingSummary(storeId, request.user);
  }

  @Get('stores/:storeId/services')
  @UseGuards(JwtAuthGuard)
  getStoreServices(
    @Param('storeId') storeId: string,
    @Request() request: { user: AuthTokenPayload },
  ) {
    return this.billingService.getStoreServices(storeId, request.user);
  }

  @Post('stores/:storeId/services')
  @UseGuards(JwtAuthGuard)
  addStoreService(
    @Param('storeId') storeId: string,
    @Body() body: Record<string, unknown>,
    @Request() request: { user: AuthTokenPayload },
  ) {
    return this.billingService.addStoreService(storeId, body, request.user);
  }

  @Post('stores/:storeId/services/loyalty')
  @UseGuards(JwtAuthGuard)
  addLoyaltyService(
    @Param('storeId') storeId: string,
    @Body() body: Record<string, unknown>,
    @Request() request: { user: AuthTokenPayload },
  ) {
    return this.billingService.addStoreService(
      storeId,
      { service: 'LOYALTY', confirmed: body.confirmed },
      request.user,
    );
  }

  @Delete('stores/:storeId/services/loyalty')
  @UseGuards(JwtAuthGuard)
  removeLoyaltyService(
    @Param('storeId') storeId: string,
    @Request() request: { user: AuthTokenPayload },
  ) {
    return this.billingService.removeStoreService(storeId, request.user);
  }

  @Post('checkout-session')
  @UseGuards(JwtAuthGuard)
  async createCheckoutSession(
    @Body() body: Record<string, unknown>,
    @Request() request: { user: AuthTokenPayload },
  ) {
    try {
      return await this.billingService.createCheckoutSession(
        body,
        request.user,
      );
    } catch (error: unknown) {
      this.logCheckoutError(error);

      if (error instanceof HttpException) {
        const status = error.getStatus();

        if (status < Number(HttpStatus.INTERNAL_SERVER_ERROR)) {
          throw error;
        }
      }

      if (process.env.NODE_ENV !== 'production') {
        throw new HttpException(
          {
            statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
            message: 'Checkout session creation failed',
            diagnostic:
              error instanceof Error ? error.message : 'Unknown checkout error',
            errorType: this.errorValue(error, 'type') ?? this.errorName(error),
            errorCode: this.errorValue(error, 'code'),
          },
          HttpStatus.INTERNAL_SERVER_ERROR,
        );
      }

      throw new InternalServerErrorException(
        'Checkout session creation failed',
      );
    }
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

  private logCheckoutError(error: unknown) {
    const payload = this.checkoutErrorPayload(error);

    this.logger.error('CHECKOUT SESSION ERROR', payload.stack);
  }

  private checkoutErrorPayload(error: unknown) {
    return {
      name: this.errorName(error),
      message: error instanceof Error ? error.message : String(error),
      code: this.errorValue(error, 'code'),
      type: this.errorValue(error, 'type'),
      requestId: this.errorValue(error, 'requestId'),
      meta: this.errorValue(error, 'meta'),
      stack: error instanceof Error ? error.stack : undefined,
    };
  }

  private errorName(error: unknown) {
    return error instanceof Error ? error.name : undefined;
  }

  private errorValue(error: unknown, key: string) {
    if (!error || typeof error !== 'object' || !(key in error)) {
      return undefined;
    }

    return (error as Record<string, unknown>)[key];
  }
}
