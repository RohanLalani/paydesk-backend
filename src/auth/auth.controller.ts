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

@Controller('auth')
@Throttle({ default: { ttl: 60_000, limit: 20 } })
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('register/owner')
  registerOwner(@Body() body: Record<string, unknown>) {
    return this.authService.register('owner', body);
  }

  @Post('register/partner')
  registerPartner(@Body() body: Record<string, unknown>) {
    return this.authService.register('partner', body);
  }

  @Post('register/manager')
  registerManager(@Body() body: Record<string, unknown>) {
    return this.authService.register('manager', body);
  }

  @Post('register/employee')
  registerEmployee(@Body() body: Record<string, unknown>) {
    return this.authService.register('employee', body);
  }

  @Post('login/owner')
  loginOwner(@Body() body: Record<string, unknown>) {
    return this.authService.login('owner', body);
  }

  @Post('login/partner')
  loginPartner(@Body() body: Record<string, unknown>) {
    return this.authService.login('partner', body);
  }

  @Post('login/manager')
  loginManager(@Body() body: Record<string, unknown>) {
    return this.authService.login('manager', body);
  }

  @Post('login/employee')
  loginEmployee(@Body() body: Record<string, unknown>) {
    return this.authService.login('employee', body);
  }

  @Patch('owner/:id')
  @UseGuards(JwtAuthGuard)
  updateOwner(
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
    @Request() request: { user: AuthTokenPayload },
  ) {
    return this.authService.updateAuthenticated('owner', id, body, request.user);
  }

  @Patch('partner/:id')
  @UseGuards(JwtAuthGuard)
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
  forgotOwnerPassword(@Body() body: Record<string, unknown>) {
    return this.authService.forgotPassword('owner', body);
  }

  @Post('forgot-password/partner')
  forgotPartnerPassword(@Body() body: Record<string, unknown>) {
    return this.authService.forgotPassword('partner', body);
  }

  @Post('forgot-password/manager')
  forgotManagerPassword(@Body() body: Record<string, unknown>) {
    return this.authService.forgotPassword('manager', body);
  }

  @Post('forgot-password/employee')
  forgotEmployeePassword(@Body() body: Record<string, unknown>) {
    return this.authService.forgotPassword('employee', body);
  }

  @Post('forgot-password/:type')
  forgotPassword(
    @Param('type') type: string,
    @Body() body: Record<string, unknown>,
  ) {
    return this.authService.forgotPasswordByType(type, body);
  }

  @Post('reset-password/:type')
  resetPassword(
    @Param('type') type: string,
    @Body() body: Record<string, unknown>,
  ) {
    return this.authService.resetPasswordByType(type, body);
  }

  @Post('verify-email/:type')
  verifyEmail(
    @Param('type') type: string,
    @Body() body: Record<string, unknown>,
  ) {
    return this.authService.verifyEmailByType(type, body);
  }
}
