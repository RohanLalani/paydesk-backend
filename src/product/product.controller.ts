import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';

import { ProductService } from './product.service';

import { JwtGuard } from '../auth/guards/jwt.guard';

@Controller('product')
export class ProductController {

  constructor(
    private readonly productService:
      ProductService,
  ) {}

  //
  // CREATE GROUP
  //
  @UseGuards(JwtGuard)
  @Post('group/create')
  createGroup(
    @Req() req: any,
    @Body() body: any,
  ) {

    return this.productService.createGroup(
      req.user.ownerId,
      body,
    );
  }

//
// CREATE DEPARTMENT
//
@UseGuards(JwtGuard)
@Post('department/create')
createDepartment(
  @Req() req: any,
  @Body() body: any,
) {

  return this.productService.createDepartment(
    req.user.ownerId,
    body,
  );
}

//
// GET DEPARTMENTS
//
@UseGuards(JwtGuard)
@Get('department/list')
getDepartments(
  @Req() req: any,
  @Query('storeId') storeId: string,
) {

  return this.productService.getDepartments(
    req.user.ownerId,
    storeId,
  );
}

  //
  // CREATE TAX
  //
  @UseGuards(JwtGuard)
  @Post('tax/create')
  createTax(
    @Req() req: any,
    @Body() body: any,
  ) {

    return this.productService.createTax(
      req.user.ownerId,
      body,
    );
  }

  //
  // CREATE PRODUCT
  //
  @UseGuards(JwtGuard)
  @Post('create')
  createProduct(
    @Req() req: any,
    @Body() body: any,
  ) {

    return this.productService.createProduct(
      req.user.ownerId,
      body,
    );
  }

  //
  // BARCODE LOOKUP
  //
  @UseGuards(JwtGuard)
  @Get('barcode/:storeId/:barcode')
  barcodeLookup(
    @Param('storeId') storeId: string,
    @Param('barcode') barcode: string,
  ) {

    return this.productService.barcodeLookup(
      storeId,
      barcode,
    );
  }

  //
  // PRODUCT SEARCH
  //
  @UseGuards(JwtGuard)
  @Get('search')
  searchProducts(
    @Query('storeId') storeId: string,
    @Query('query') query: string,
  ) {

    return this.productService.searchProducts(
      storeId,
      query,
    );
  }

  //
  // INVENTORY ADJUSTMENT
  //
  @UseGuards(JwtGuard)
  @Post('inventory/adjust')
  adjustInventory(
    @Req() req: any,
    @Body() body: any,
  ) {

    return this.productService.adjustInventory(
      req.user,
      body,
    );
  }

//
// RECEIVE CASE INVENTORY
//
@UseGuards(JwtGuard)
@Post('inventory/receive-case')
receiveCaseInventory(
  @Req() req: any,
  @Body() body: any,
) {

  return this.productService.receiveCaseInventory(
    req.user,
    body,
  );
}

//
// CASE BREAKDOWN
//
@UseGuards(JwtGuard)
@Get('inventory/case-breakdown/:productId')
getCaseBreakdown(
  @Param('productId')
  productId: string,
) {

  return this.productService.getCaseBreakdown(
    productId,
  );
}

}