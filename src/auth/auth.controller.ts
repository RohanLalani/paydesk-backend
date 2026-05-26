import {
  Body,
  Controller,
  Param,
  Patch,
  Post,
  Request,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from './guards/jwt.guard';
import { AuthTokenPayload } from './strategies/jwt.strategy';

const AUTH_WINDOW_MS = 60_000;
const SENSITIVE_WINDOW_MS = 15 * 60_000;

@Controller('auth')
@Throttle({ default: { ttl: 60_000, limit: 20 } })
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('register/owner')
  @Throttle({ default: { ttl: SENSITIVE_WINDOW_MS, limit: 5 } })
  registerOwner(@Body() body: Record<string, unknown>) {
    return this.authService.register('owner', body);
  }

  @Post('register/partner')
  @Throttle({ default: { ttl: SENSITIVE_WINDOW_MS, limit: 5 } })
  registerPartner(@Body() body: Record<string, unknown>) {
    return this.authService.register('partner', body);
  }

  @Post('register/manager')
  @Throttle({ default: { ttl: SENSITIVE_WINDOW_MS, limit: 5 } })
  registerManager(@Body() body: Record<string, unknown>) {
    return this.authService.register('manager', body);
  }

  @Post('register/employee')
  @Throttle({ default: { ttl: SENSITIVE_WINDOW_MS, limit: 5 } })
  registerEmployee(@Body() body: Record<string, unknown>) {
    return this.authService.register('employee', body);
  }

  @Post('login/owner')
  @Throttle({ default: { ttl: AUTH_WINDOW_MS, limit: 5 } })
  loginOwner(@Body() body: Record<string, unknown>) {
    return this.authService.login('owner', body);
  }

  @Post('login/partner')
  @Throttle({ default: { ttl: AUTH_WINDOW_MS, limit: 5 } })
  loginPartner(@Body() body: Record<string, unknown>) {
    return this.authService.login('partner', body);
  }

  @Post('login/manager')
  @Throttle({ default: { ttl: AUTH_WINDOW_MS, limit: 5 } })
  loginManager(@Body() body: Record<string, unknown>) {
    return this.authService.login('manager', body);
  }

  @Post('login/employee')
  @Throttle({ default: { ttl: AUTH_WINDOW_MS, limit: 5 } })
  loginEmployee(@Body() body: Record<string, unknown>) {
    return this.authService.login('employee', body);
  }

  @Patch('owner/:id')
  @UseGuards(JwtAuthGuard)
  @Throttle({ default: { ttl: AUTH_WINDOW_MS, limit: 10 } })
  updateOwner(
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
    @Request() request: { user: AuthTokenPayload },
  ) {
    return this.authService.updateAuthenticated(
      'owner',
      id,
      body,
      request.user,
    );
  }

  @Patch('partner/:id')
  @UseGuards(JwtAuthGuard)
  @Throttle({ default: { ttl: AUTH_WINDOW_MS, limit: 10 } })
  updatePartner(
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
    @Request() request: { user: AuthTokenPayload },
  ) {
    return this.authService.updateAuthenticated(
      'partner',
      id,
      body,
      request.user,
    );
  }

  @Patch('manager/:id')
  @UseGuards(JwtAuthGuard)
  @Throttle({ default: { ttl: AUTH_WINDOW_MS, limit: 10 } })
  updateManager(
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
    @Request() request: { user: AuthTokenPayload },
  ) {
    return this.authService.updateAuthenticated(
      'manager',
      id,
      body,
      request.user,
    );
  }

  @Patch('employee/:id')
  @UseGuards(JwtAuthGuard)
  @Throttle({ default: { ttl: AUTH_WINDOW_MS, limit: 10 } })
  updateEmployee(
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
    @Request() request: { user: AuthTokenPayload },
  ) {
    return this.authService.updateAuthenticated(
      'employee',
      id,
      body,
      request.user,
    );
  }

  @Post('forgot-password/owner')
  @Throttle({ default: { ttl: SENSITIVE_WINDOW_MS, limit: 3 } })
  forgotOwnerPassword(@Body() body: Record<string, unknown>) {
    return this.authService.forgotPassword('owner', body);
  }

  @Post('forgot-password/partner')
  @Throttle({ default: { ttl: SENSITIVE_WINDOW_MS, limit: 3 } })
  forgotPartnerPassword(@Body() body: Record<string, unknown>) {
    return this.authService.forgotPassword('partner', body);
  }

  @Post('forgot-password/manager')
  @Throttle({ default: { ttl: SENSITIVE_WINDOW_MS, limit: 3 } })
  forgotManagerPassword(@Body() body: Record<string, unknown>) {
    return this.authService.forgotPassword('manager', body);
  }

  @Post('forgot-password/employee')
  @Throttle({ default: { ttl: SENSITIVE_WINDOW_MS, limit: 3 } })
  forgotEmployeePassword(@Body() body: Record<string, unknown>) {
    return this.authService.forgotPassword('employee', body);
  }

  @Post('forgot-password/:type')
  @Throttle({ default: { ttl: SENSITIVE_WINDOW_MS, limit: 3 } })
  forgotPassword(
    @Param('type') type: string,
    @Body() body: Record<string, unknown>,
  ) {
    return this.authService.forgotPasswordByType(type, body);
  }

  @Post('reset-password/:type')
  @Throttle({ default: { ttl: SENSITIVE_WINDOW_MS, limit: 5 } })
  resetPassword(
    @Param('type') type: string,
    @Body() body: Record<string, unknown>,
  ) {
    return this.authService.resetPasswordByType(type, body);
  }

  @Post('verify-email/:type')
  @Throttle({ default: { ttl: SENSITIVE_WINDOW_MS, limit: 10 } })
  verifyEmail(
    @Param('type') type: string,
    @Body() body: Record<string, unknown>,
  ) {
    return this.authService.verifyEmailByType(type, body);
  }
}
