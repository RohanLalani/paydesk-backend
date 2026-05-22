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
import { CustomerService } from './customer.service';

@Controller('customer')
@UseGuards(JwtAuthGuard)
export class CustomerController {
  constructor(private readonly customerService: CustomerService) {}

  @Post('create')
  create(
    @Body() body: Record<string, unknown>,
    @Request() request: { user: AuthTokenPayload },
  ) {
    return this.customerService.create(body, request.user);
  }

  @Get('phone/:phone')
  findByPhone(
    @Param('phone') phone: string,
    @Request() request: { user: AuthTokenPayload },
  ) {
    return this.customerService.findByPhone(phone, request.user);
  }

  @Get('store/:storeId')
  listByStore(
    @Param('storeId') storeId: string,
    @Request() request: { user: AuthTokenPayload },
  ) {
    return this.customerService.listByStore(storeId, request.user);
  }

  @Post('tier-rule/create')
  createTierRule(
    @Body() body: Record<string, unknown>,
    @Request() request: { user: AuthTokenPayload },
  ) {
    return this.customerService.createTierRule(body, request.user);
  }

  @Post('tier/create')
  createTier(
    @Body() body: Record<string, unknown>,
    @Request() request: { user: AuthTokenPayload },
  ) {
    return this.customerService.createTier(body, request.user);
  }

  @Get(':id/purchases')
  purchases(
    @Param('id') id: string,
    @Request() request: { user: AuthTokenPayload },
  ) {
    return this.customerService.getPurchases(id, request.user);
  }

  @Post(':id/recalculate-tier')
  recalculateTier(
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
    @Request() request: { user: AuthTokenPayload },
  ) {
    return this.customerService.recalculateCustomerTier(id, body, request.user);
  }

  @Get(':customerNumber')
  findByCustomerNumber(
    @Param('customerNumber') customerNumber: string,
    @Request() request: { user: AuthTokenPayload },
  ) {
    return this.customerService.findByCustomerNumber(
      customerNumber,
      request.user,
    );
  }

  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
    @Request() request: { user: AuthTokenPayload },
  ) {
    return this.customerService.update(id, body, request.user);
  }
}
