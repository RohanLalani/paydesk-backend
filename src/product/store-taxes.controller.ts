import {
  Body,
  Controller,
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
import { ProductService } from './product.service';

@Controller('stores/:storeId/taxes')
@UseGuards(JwtAuthGuard)
export class StoreTaxesController {
  constructor(private readonly productService: ProductService) {}

  @Get()
  list(
    @Param('storeId') storeId: string,
    @Query() query: Record<string, unknown>,
    @Request() request: { user: AuthTokenPayload },
  ) {
    return this.productService.listStoreTaxes(storeId, request.user, query);
  }

  @Post()
  create(
    @Param('storeId') storeId: string,
    @Body() body: Record<string, unknown>,
    @Request() request: { user: AuthTokenPayload },
  ) {
    return this.productService.createStoreTax(storeId, body, request.user);
  }

  @Get(':taxId')
  get(
    @Param('storeId') storeId: string,
    @Param('taxId') taxId: string,
    @Request() request: { user: AuthTokenPayload },
  ) {
    return this.productService.getStoreTax(storeId, taxId, request.user);
  }

  @Patch(':taxId')
  update(
    @Param('storeId') storeId: string,
    @Param('taxId') taxId: string,
    @Body() body: Record<string, unknown>,
    @Request() request: { user: AuthTokenPayload },
  ) {
    return this.productService.updateStoreTax(
      storeId,
      taxId,
      body,
      request.user,
    );
  }
}
