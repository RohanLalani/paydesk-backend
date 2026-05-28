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
import { ProductService } from './product.service';

@Controller('product')
@UseGuards(JwtAuthGuard)
export class ProductController {
  constructor(private readonly productService: ProductService) {}

  @Post('department/create')
  createDepartment(
    @Body() body: Record<string, unknown>,
    @Request() request: { user: AuthTokenPayload },
  ) {
    return this.productService.createDepartment(body, request.user);
  }

  @Get('department/store/:storeId')
  listDepartments(
    @Param('storeId') storeId: string,
    @Request() request: { user: AuthTokenPayload },
  ) {
    return this.productService.listDepartments(storeId, request.user);
  }

  @Patch('department/:id')
  updateDepartment(
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
    @Request() request: { user: AuthTokenPayload },
  ) {
    return this.productService.updateDepartment(id, body, request.user);
  }

  @Delete('department/:id')
  deleteDepartment(
    @Param('id') id: string,
    @Request() request: { user: AuthTokenPayload },
  ) {
    return this.productService.deleteDepartment(id, request.user);
  }

  @Post('price-group/create')
  createPriceGroup(
    @Body() body: Record<string, unknown>,
    @Request() request: { user: AuthTokenPayload },
  ) {
    return this.productService.createPriceGroup(body, request.user);
  }

  @Get('price-group/store/:storeId')
  listPriceGroups(
    @Param('storeId') storeId: string,
    @Request() request: { user: AuthTokenPayload },
  ) {
    return this.productService.listPriceGroups(storeId, request.user);
  }

  @Patch('price-group/:id')
  updatePriceGroup(
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
    @Request() request: { user: AuthTokenPayload },
  ) {
    return this.productService.updatePriceGroup(id, body, request.user);
  }

  @Delete('price-group/:id')
  deletePriceGroup(
    @Param('id') id: string,
    @Request() request: { user: AuthTokenPayload },
  ) {
    return this.productService.deletePriceGroup(id, request.user);
  }

  @Post('category/create')
  createProductCategory(
    @Body() body: Record<string, unknown>,
    @Request() request: { user: AuthTokenPayload },
  ) {
    return this.productService.createProductCategory(body, request.user);
  }

  @Get('category/store/:storeId')
  listProductCategories(
    @Param('storeId') storeId: string,
    @Request() request: { user: AuthTokenPayload },
  ) {
    return this.productService.listProductCategories(storeId, request.user);
  }

  @Patch('category/:id')
  updateProductCategory(
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
    @Request() request: { user: AuthTokenPayload },
  ) {
    return this.productService.updateProductCategory(id, body, request.user);
  }

  @Delete('category/:id')
  deleteProductCategory(
    @Param('id') id: string,
    @Request() request: { user: AuthTokenPayload },
  ) {
    return this.productService.deleteProductCategory(id, request.user);
  }

  @Post('tax/create')
  createTax(
    @Body() body: Record<string, unknown>,
    @Request() request: { user: AuthTokenPayload },
  ) {
    return this.productService.createTax(body, request.user);
  }

  @Get('tax/store/:storeId')
  listTaxes(
    @Param('storeId') storeId: string,
    @Request() request: { user: AuthTokenPayload },
  ) {
    return this.productService.listTaxes(storeId, request.user);
  }

  @Patch('tax/:id')
  updateTax(
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
    @Request() request: { user: AuthTokenPayload },
  ) {
    return this.productService.updateTax(id, body, request.user);
  }

  @Delete('tax/:id')
  deleteTax(
    @Param('id') id: string,
    @Request() request: { user: AuthTokenPayload },
  ) {
    return this.productService.deleteTax(id, request.user);
  }

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

  @Post('inventory/receive')
  receiveInventory(
    @Body() body: Record<string, unknown>,
    @Request() request: { user: AuthTokenPayload },
  ) {
    return this.productService.receiveInventory(body, request.user);
  }

  @Post('inventory/adjust')
  adjustInventory(
    @Body() body: Record<string, unknown>,
    @Request() request: { user: AuthTokenPayload },
  ) {
    return this.productService.adjustInventory(body, request.user);
  }

  @Get('inventory/logs/store/:storeId')
  listInventoryLogsByStore(
    @Param('storeId') storeId: string,
    @Query() query: Record<string, unknown>,
    @Request() request: { user: AuthTokenPayload },
  ) {
    return this.productService.listInventoryLogsByStore(
      storeId,
      request.user,
      query,
    );
  }

  @Get('inventory/logs/product/:productId')
  listInventoryLogsByProduct(
    @Param('productId') productId: string,
    @Query() query: Record<string, unknown>,
    @Request() request: { user: AuthTokenPayload },
  ) {
    return this.productService.listInventoryLogsByProduct(
      productId,
      request.user,
      query,
    );
  }

  @Get('inventory/low-stock/:storeId')
  listLowStock(
    @Param('storeId') storeId: string,
    @Request() request: { user: AuthTokenPayload },
  ) {
    return this.productService.listLowStock(storeId, request.user);
  }

  @Get('inventory/out-of-stock/:storeId')
  listOutOfStock(
    @Param('storeId') storeId: string,
    @Request() request: { user: AuthTokenPayload },
  ) {
    return this.productService.listOutOfStock(storeId, request.user);
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
