import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Request,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt.guard';
import { AuthTokenPayload } from '../auth/strategies/jwt.strategy';
import { CartService } from './cart.service';

@Controller('cart')
@UseGuards(JwtAuthGuard)
export class CartController {
  constructor(private readonly cartService: CartService) {}

  @Post('start')
  start(
    @Body() body: Record<string, unknown>,
    @Request() request: { user: AuthTokenPayload },
  ) {
    return this.cartService.start(body, request.user);
  }

  @Post(':cartId/add-barcode')
  addBarcode(
    @Param('cartId') cartId: string,
    @Body() body: Record<string, unknown>,
    @Request() request: { user: AuthTokenPayload },
  ) {
    return this.cartService.addBarcode(cartId, body, request.user);
  }

  @Patch(':cartId/item/:itemId/quantity')
  updateQuantity(
    @Param('cartId') cartId: string,
    @Param('itemId') itemId: string,
    @Body() body: Record<string, unknown>,
    @Request() request: { user: AuthTokenPayload },
  ) {
    return this.cartService.updateQuantity(cartId, itemId, body, request.user);
  }

  @Patch(':cartId/item/:itemId/price-override')
  priceOverride(
    @Param('cartId') cartId: string,
    @Param('itemId') itemId: string,
    @Body() body: Record<string, unknown>,
    @Request() request: { user: AuthTokenPayload },
  ) {
    return this.cartService.priceOverride(cartId, itemId, body, request.user);
  }

  @Post(':cartId/customer/phone')
  attachCustomerByPhone(
    @Param('cartId') cartId: string,
    @Body() body: Record<string, unknown>,
    @Request() request: { user: AuthTokenPayload },
  ) {
    return this.cartService.attachCustomerByPhone(cartId, body, request.user);
  }

  @Get(':cartId')
  findOne(
    @Param('cartId') cartId: string,
    @Request() request: { user: AuthTokenPayload },
  ) {
    return this.cartService.findOne(cartId, request.user);
  }

  @Post(':cartId/prepare-payment')
  preparePayment(
    @Param('cartId') cartId: string,
    @Request() request: { user: AuthTokenPayload },
  ) {
    return this.cartService.preparePayment(cartId, request.user);
  }
}
