import {
  Body,
  Controller,
  Get,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';

import { ShiftService } from './shift.service';

import { JwtGuard } from '../auth/guards/jwt.guard';

@Controller('shift')
export class ShiftController {

  constructor(
    private readonly shiftService:
      ShiftService,
  ) {}

  //
  // START SHIFT
  //
  @UseGuards(JwtGuard)
  @Post('start')
  startShift(
    @Req() req: any,

    @Body()
    body: {
      storeId: string;
    },
  ) {

    return this.shiftService.startShift(
      req.user,
      body,
    );
  }

  //
  // END SHIFT
  //
  @UseGuards(JwtGuard)
  @Post('end')
  endShift(
    @Req() req: any,
  ) {

    return this.shiftService.endShift(
      req.user,
    );
  }

  //
  // CURRENT SHIFT
  //
  @UseGuards(JwtGuard)
  @Get('current')
  currentShift(
    @Req() req: any,
  ) {

    return this.shiftService.currentShift(
      req.user,
    );
  }
}