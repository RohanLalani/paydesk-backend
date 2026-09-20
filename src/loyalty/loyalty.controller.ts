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
import { LoyaltyService } from './loyalty.service';
import type {
  LoyaltyPointsProgramInput,
  PunchCardProgramInput,
} from './loyalty.types';

@Controller('stores/:storeId/loyalty/points-programs')
@UseGuards(JwtAuthGuard)
export class LoyaltyController {
  constructor(private readonly service: LoyaltyService) {}

  @Get()
  list(
    @Param('storeId') storeId: string,
    @Request() request: { user: AuthTokenPayload },
  ) {
    return this.service.listPointsPrograms(storeId, request.user);
  }

  @Get(':programId')
  get(
    @Param('storeId') storeId: string,
    @Param('programId') programId: string,
    @Request() request: { user: AuthTokenPayload },
  ) {
    return this.service.getPointsProgram(storeId, programId, request.user);
  }

  @Post()
  create(
    @Param('storeId') storeId: string,
    @Body() body: LoyaltyPointsProgramInput,
    @Request() request: { user: AuthTokenPayload },
  ) {
    return this.service.createPointsProgram(storeId, body, request.user);
  }

  @Patch(':programId')
  update(
    @Param('storeId') storeId: string,
    @Param('programId') programId: string,
    @Body() body: LoyaltyPointsProgramInput,
    @Request() request: { user: AuthTokenPayload },
  ) {
    return this.service.updatePointsProgram(
      storeId,
      programId,
      body,
      request.user,
    );
  }
}

@Controller('stores/:storeId/loyalty/punch-card-programs')
@UseGuards(JwtAuthGuard)
export class PunchCardLoyaltyController {
  constructor(private readonly service: LoyaltyService) {}

  @Get()
  list(
    @Param('storeId') storeId: string,
    @Request() request: { user: AuthTokenPayload },
  ) {
    return this.service.listPunchCardPrograms(storeId, request.user);
  }

  @Get(':programId')
  get(
    @Param('storeId') storeId: string,
    @Param('programId') programId: string,
    @Request() request: { user: AuthTokenPayload },
  ) {
    return this.service.getPunchCardProgram(storeId, programId, request.user);
  }

  @Post()
  create(
    @Param('storeId') storeId: string,
    @Body() body: PunchCardProgramInput,
    @Request() request: { user: AuthTokenPayload },
  ) {
    return this.service.createPunchCardProgram(storeId, body, request.user);
  }

  @Patch(':programId')
  update(
    @Param('storeId') storeId: string,
    @Param('programId') programId: string,
    @Body() body: PunchCardProgramInput,
    @Request() request: { user: AuthTokenPayload },
  ) {
    return this.service.updatePunchCardProgram(
      storeId,
      programId,
      body,
      request.user,
    );
  }
}
