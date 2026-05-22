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
import { PriceGroupService } from './price-groups.service';

@Controller('product/price-group')
@UseGuards(JwtAuthGuard)
export class PriceGroupController {
  constructor(private readonly priceGroupService: PriceGroupService) {}

  @Post('create')
  create(
    @Body() body: Record<string, unknown>,
    @Request() request: { user: AuthTokenPayload },
  ) {
    return this.priceGroupService.create(body, request.user);
  }

  @Get('store/:storeId')
  listByStore(
    @Param('storeId') storeId: string,
    @Request() request: { user: AuthTokenPayload },
  ) {
    return this.priceGroupService.listByStore(storeId, request.user);
  }

  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
    @Request() request: { user: AuthTokenPayload },
  ) {
    return this.priceGroupService.update(id, body, request.user);
  }

  @Delete(':id')
  remove(
    @Param('id') id: string,
    @Request() request: { user: AuthTokenPayload },
  ) {
    return this.priceGroupService.remove(id, request.user);
  }
}
