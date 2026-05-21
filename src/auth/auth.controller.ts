import { Body, Controller, Param, Patch, Post } from '@nestjs/common';
import { AuthService } from './auth.service';

@Controller('auth')
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
  updateOwner(@Param('id') id: string, @Body() body: Record<string, unknown>) {
    return this.authService.update('owner', id, body);
  }

  @Patch('partner/:id')
  updatePartner(@Param('id') id: string, @Body() body: Record<string, unknown>) {
    return this.authService.update('partner', id, body);
  }

  @Patch('manager/:id')
  updateManager(@Param('id') id: string, @Body() body: Record<string, unknown>) {
    return this.authService.update('manager', id, body);
  }

  @Patch('employee/:id')
  updateEmployee(@Param('id') id: string, @Body() body: Record<string, unknown>) {
    return this.authService.update('employee', id, body);
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
