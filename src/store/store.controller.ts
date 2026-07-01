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
import { StoreService } from './store.service';

@Controller('store')
@UseGuards(JwtAuthGuard)
export class StoreController {
  constructor(private readonly storeService: StoreService) {}

  @Post('create')
  create(
    @Body() body: Record<string, unknown>,
    @Request() request: { user: AuthTokenPayload },
  ) {
    return this.storeService.create(body, request.user);
  }

  @Patch(':storeId')
  update(
    @Param('storeId') storeId: string,
    @Body() body: Record<string, unknown>,
    @Request() request: { user: AuthTokenPayload },
  ) {
    return this.storeService.update(storeId, body, request.user);
  }

  @Patch(':storeId/activate')
  activate(
    @Param('storeId') storeId: string,
    @Request() request: { user: AuthTokenPayload },
  ) {
    return this.storeService.activateStore(storeId, request.user);
  }

  @Delete(':storeId')
  remove(
    @Param('storeId') storeId: string,
    @Request() request: { user: AuthTokenPayload },
  ) {
    return this.storeService.remove(storeId, request.user);
  }

  @Get('my-stores')
  myStores(
    @Request() request: { user: AuthTokenPayload },
    @Query('includeInactive') includeInactive?: string,
  ) {
    return this.storeService.myStores(request.user, includeInactive === 'true');
  }

  @Get(':storeId')
  findOne(
    @Param('storeId') storeId: string,
    @Request() request: { user: AuthTokenPayload },
  ) {
    return this.storeService.findOne(storeId, request.user);
  }
}
