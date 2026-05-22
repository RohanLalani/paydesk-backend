import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Request,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt.guard';
import { AuthTokenPayload } from '../auth/strategies/jwt.strategy';
import { ProductService } from './product.service';

@Controller('product')
@UseGuards(JwtAuthGuard)
export class ProductController {
  constructor(private readonly productService: ProductService) {}

  @Post('create')
  create(
    @Body() body: Record<string, unknown>,
    @Request() request: { user: AuthTokenPayload },
  ) {
    return this.productService.create(body, request.user);
  }

  @Patch(':productId')
  update(
    @Param('productId') productId: string,
    @Body() body: Record<string, unknown>,
    @Request() request: { user: AuthTokenPayload },
  ) {
    return this.productService.update(productId, body, request.user);
  }

  @Get('store/:storeId')
  listByStore(
    @Param('storeId') storeId: string,
    @Request() request: { user: AuthTokenPayload },
  ) {
    return this.productService.listByStore(storeId, request.user);
  }

  @Get('barcode/:storeId/:barcode')
  findByBarcode(
    @Param('storeId') storeId: string,
    @Param('barcode') barcode: string,
    @Request() request: { user: AuthTokenPayload },
  ) {
    return this.productService.findByBarcode(storeId, barcode, request.user);
  }

  @Get(':productId')
  findOne(
    @Param('productId') productId: string,
    @Request() request: { user: AuthTokenPayload },
  ) {
    return this.productService.findOne(productId, request.user);
  }

  @Delete(':productId')
  remove(
    @Param('productId') productId: string,
    @Request() request: { user: AuthTokenPayload },
  ) {
    return this.productService.remove(productId, request.user);
  }
}
