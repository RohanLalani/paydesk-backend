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

  // ✅ REGISTER
  @Post('register')
  register(
    @Body()
    body: {
      email: string;
      password: string;
      role: string;
      name?: string;
    },
  ) {
    return this.authService.register(body);
  }

  // ✅ LOGIN
  @Post('login')
  login(
    @Body()
    body: {
      email: string;
      password: string;
    },
  ) {
    return this.authService.login(
      body.email,
      body.password,
    );
  }
}