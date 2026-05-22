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
import { ProductCategoryService } from './product-category.service';

@Controller('product/category')
@UseGuards(JwtAuthGuard)
export class ProductCategoryController {
  constructor(private readonly categoryService: ProductCategoryService) {}

  @Post('create')
  create(
    @Body() body: Record<string, unknown>,
    @Request() request: { user: AuthTokenPayload },
  ) {
    return this.categoryService.create(body, request.user);
  }

  @Get('store/:storeId')
  listByStore(
    @Param('storeId') storeId: string,
    @Request() request: { user: AuthTokenPayload },
  ) {
    return this.categoryService.listByStore(storeId, request.user);
  }

  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
    @Request() request: { user: AuthTokenPayload },
  ) {
    return this.categoryService.update(id, body, request.user);
  }

  @Delete(':id')
  remove(
    @Param('id') id: string,
    @Request() request: { user: AuthTokenPayload },
  ) {
    return this.categoryService.remove(id, request.user);
  }
}
