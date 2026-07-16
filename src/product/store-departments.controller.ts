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

@Controller('stores/:storeId/departments')
@UseGuards(JwtAuthGuard)
export class StoreDepartmentsController {
  constructor(private readonly productService: ProductService) {}

  @Get()
  list(
    @Param('storeId') storeId: string,
    @Query() query: Record<string, unknown>,
    @Request() request: { user: AuthTokenPayload },
  ) {
    return this.productService.listStoreDepartments(
      storeId,
      request.user,
      query,
    );
  }

  @Post()
  create(
    @Param('storeId') storeId: string,
    @Body() body: Record<string, unknown>,
    @Request() request: { user: AuthTokenPayload },
  ) {
    return this.productService.createStoreDepartment(
      storeId,
      body,
      request.user,
    );
  }

  @Patch(':departmentId')
  update(
    @Param('storeId') storeId: string,
    @Param('departmentId') departmentId: string,
    @Body() body: Record<string, unknown>,
    @Request() request: { user: AuthTokenPayload },
  ) {
    return this.productService.updateStoreDepartment(
      storeId,
      departmentId,
      body,
      request.user,
    );
  }
}
