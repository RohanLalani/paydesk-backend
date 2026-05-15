import {
  Body,
  Controller,
  Get,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';

import { StoreService } from './store.service';

import { JwtGuard } from '../auth/guards/jwt.guard';

@Controller('store')
export class StoreController {

  constructor(
    private readonly storeService: StoreService,
  ) {}

  //
  // CREATE STORE
  //
  @UseGuards(JwtGuard)
  @Post('create')
  createStore(
    @Req() req: any,

    @Body()
    body: {
      name: string;
      inventoryMode?: string;
    },
  ) {

    return this.storeService.createStore(
      req.user.ownerId,
      body,
    );
  }

  //
  // GET MY STORES
  //
  @UseGuards(JwtGuard)
  @Get('my-stores')
  getMyStores(
    @Req() req: any,
  ) {

    return this.storeService.getOwnerStores(
      req.user.ownerId,
    );
  }
}