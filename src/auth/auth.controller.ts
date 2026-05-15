import {
  Body,
  Controller,
  Post,
} from '@nestjs/common';

import { AuthService } from './auth.service';

@Controller('auth')
export class AuthController {

  constructor(
    private readonly authService: AuthService,
  ) {}

  //
  // OWNER REGISTER
  //
  @Post('owner/register')
  registerOwner(
    @Body()
    body: {
      email: string;
      password: string;
      name?: string;
    },
  ) {
    return this.authService.registerOwner(
      body,
    );
  }

  //
  // OWNER LOGIN
  //
  @Post('owner/login')
  loginOwner(
    @Body()
    body: {
      email: string;
      password: string;
    },
  ) {
    return this.authService.loginOwner(
      body.email,
      body.password,
    );
  }
}