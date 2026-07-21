import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Request,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt.guard';
import { AuthTokenPayload } from '../auth/strategies/jwt.strategy';
import { VendorOrdersService } from './vendor-orders.service';

@Controller('stores/:storeId')
@UseGuards(JwtAuthGuard)
export class VendorOrdersController {
  constructor(private readonly vendorOrdersService: VendorOrdersService) {}

  @Get('product-vendors')
  listProductVendors(
    @Param('storeId') storeId: string,
    @Query() query: Record<string, unknown>,
    @Request() request: { user: AuthTokenPayload },
  ) {
    return this.vendorOrdersService.listProductVendors(
      storeId,
      query,
      request.user,
    );
  }

  @Post('product-vendors')
  createProductVendor(
    @Param('storeId') storeId: string,
    @Body() body: Record<string, unknown>,
    @Request() request: { user: AuthTokenPayload },
  ) {
    return this.vendorOrdersService.createProductVendor(
      storeId,
      body,
      request.user,
    );
  }

  @Patch('product-vendors/:productVendorId')
  updateProductVendor(
    @Param('storeId') storeId: string,
    @Param('productVendorId') productVendorId: string,
    @Body() body: Record<string, unknown>,
    @Request() request: { user: AuthTokenPayload },
  ) {
    return this.vendorOrdersService.updateProductVendor(
      storeId,
      productVendorId,
      body,
      request.user,
    );
  }

  @Delete('product-vendors/:productVendorId')
  deleteProductVendor(
    @Param('storeId') storeId: string,
    @Param('productVendorId') productVendorId: string,
    @Request() request: { user: AuthTokenPayload },
  ) {
    return this.vendorOrdersService.deleteProductVendor(
      storeId,
      productVendorId,
      request.user,
    );
  }

  @Get('vendor-orders')
  listOrders(
    @Param('storeId') storeId: string,
    @Query() query: Record<string, unknown>,
    @Request() request: { user: AuthTokenPayload },
  ) {
    return this.vendorOrdersService.listOrders(storeId, query, request.user);
  }

  @Post('vendor-orders/generate')
  generateOrders(
    @Param('storeId') storeId: string,
    @Body() body: Record<string, unknown>,
    @Request() request: { user: AuthTokenPayload },
  ) {
    return this.vendorOrdersService.generateOrders(storeId, body, request.user);
  }

  @Get('vendor-orders/:orderId')
  getOrder(
    @Param('storeId') storeId: string,
    @Param('orderId') orderId: string,
    @Request() request: { user: AuthTokenPayload },
  ) {
    return this.vendorOrdersService.getOrder(storeId, orderId, request.user);
  }

  @Patch('vendor-orders/:orderId')
  updateOrder(
    @Param('storeId') storeId: string,
    @Param('orderId') orderId: string,
    @Body() body: Record<string, unknown>,
    @Request() request: { user: AuthTokenPayload },
  ) {
    return this.vendorOrdersService.updateOrder(
      storeId,
      orderId,
      body,
      request.user,
    );
  }

  @Post('vendor-orders/:orderId/send')
  sendOrder(
    @Param('storeId') storeId: string,
    @Param('orderId') orderId: string,
    @Request() request: { user: AuthTokenPayload },
  ) {
    return this.vendorOrdersService.sendOrder(storeId, orderId, request.user);
  }

  @Post('vendor-orders/:orderId/receive')
  receiveOrder(
    @Param('storeId') storeId: string,
    @Param('orderId') orderId: string,
    @Body() body: Record<string, unknown>,
    @Request() request: { user: AuthTokenPayload },
  ) {
    return this.vendorOrdersService.receiveOrder(
      storeId,
      orderId,
      body,
      request.user,
    );
  }
}
