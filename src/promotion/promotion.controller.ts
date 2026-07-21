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
import { PromotionStatus } from '@prisma/client';
import { JwtAuthGuard } from '../auth/guards/jwt.guard';
import { AuthTokenPayload } from '../auth/strategies/jwt.strategy';
import { PromotionService } from './promotion.service';
import type { EvaluationInput, PromotionInput } from './promotion.types';

@Controller('stores/:storeId/promotions')
@UseGuards(JwtAuthGuard)
export class PromotionController {
  constructor(private readonly service: PromotionService) {}
  @Get() list(
    @Param('storeId') storeId: string,
    @Query() query: Record<string, unknown>,
    @Request() request: { user: AuthTokenPayload },
  ) {
    return this.service.list(storeId, query, request.user);
  }
  @Get('product-search') search(
    @Param('storeId') storeId: string,
    @Query() query: Record<string, unknown>,
    @Request() request: { user: AuthTokenPayload },
  ) {
    return this.service.productSearch(storeId, query, request.user);
  }
  @Post('evaluate') evaluate(
    @Param('storeId') storeId: string,
    @Body() body: EvaluationInput,
    @Request() request: { user: AuthTokenPayload },
  ) {
    return this.service.evaluate(storeId, body, request.user);
  }
  @Get(':promotionId') get(
    @Param('storeId') storeId: string,
    @Param('promotionId') id: string,
    @Request() request: { user: AuthTokenPayload },
  ) {
    return this.service.get(storeId, id, request.user);
  }
  @Post() create(
    @Param('storeId') storeId: string,
    @Body() body: PromotionInput,
    @Request() request: { user: AuthTokenPayload },
  ) {
    return this.service.create(storeId, body, request.user);
  }
  @Patch(':promotionId') update(
    @Param('storeId') storeId: string,
    @Param('promotionId') id: string,
    @Body() body: PromotionInput,
    @Request() request: { user: AuthTokenPayload },
  ) {
    return this.service.update(storeId, id, body, request.user);
  }
  @Delete(':promotionId') remove(
    @Param('storeId') storeId: string,
    @Param('promotionId') id: string,
    @Request() request: { user: AuthTokenPayload },
  ) {
    return this.service.remove(storeId, id, request.user);
  }
  @Post(':promotionId/activate') activate(
    @Param('storeId') storeId: string,
    @Param('promotionId') id: string,
    @Request() request: { user: AuthTokenPayload },
  ) {
    return this.service.transition(
      storeId,
      id,
      PromotionStatus.ACTIVE,
      request.user,
    );
  }
  @Post(':promotionId/pause') pause(
    @Param('storeId') storeId: string,
    @Param('promotionId') id: string,
    @Request() request: { user: AuthTokenPayload },
  ) {
    return this.service.transition(
      storeId,
      id,
      PromotionStatus.PAUSED,
      request.user,
    );
  }
  @Post(':promotionId/deactivate') deactivate(
    @Param('storeId') storeId: string,
    @Param('promotionId') id: string,
    @Request() request: { user: AuthTokenPayload },
  ) {
    return this.service.transition(
      storeId,
      id,
      PromotionStatus.INACTIVE,
      request.user,
    );
  }
  @Post(':promotionId/archive') archive(
    @Param('storeId') storeId: string,
    @Param('promotionId') id: string,
    @Request() request: { user: AuthTokenPayload },
  ) {
    return this.service.transition(
      storeId,
      id,
      PromotionStatus.ARCHIVED,
      request.user,
    );
  }
}
