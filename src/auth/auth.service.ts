import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Prisma, StaffRole } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { createHash, randomBytes } from 'crypto';
import { PrismaService } from '../prisma.service';
import { EmailService } from './email/email.service';
import { AuthTokenPayload } from './strategies/jwt.strategy';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  private readonly saltRounds = 10;
  private readonly resetTokenMinutes = 15;
  private readonly emailVerificationTokenHours = 24;
  private readonly maxPasswordLength = 128;
  private readonly forgotPasswordMessage =
    'If an account with that email exists, a password reset link has been sent.';

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
    private readonly emailService: EmailService,
    private readonly configService: ConfigService,
  ) {}

  async register(type: AccountType, body: Record<string, unknown>) {
    const dto = this.parseRegisterBody(body);
    await this.ensureEmailAvailable(type, dto.email);

    const password = await bcrypt.hash(dto.password, this.saltRounds);
    const account = await this.createAccount(type, {
      email: dto.email,
      name: dto.name,
      password,
    });
    const emailVerificationSent = await this.createAndSendEmailVerification(
      type,
      account,
    );

    return {
      message: emailVerificationSent
        ? `${this.label(type)} registered successfully. Please verify your email before logging in.`
        : `${this.label(type)} registered successfully, but we could not send the verification email. Please contact support to verify your account.`,
      account: this.toSafeAccount(type, account),
    };
  }

  async login(type: AccountType, body: Record<string, unknown>) {
    const email = this.requiredString(body.email, 'email').toLowerCase();
    const password = this.requiredString(body.password, 'password');
    this.validateEmail(email);
    this.validatePasswordLength(password);
    const account = await this.findAccountByEmail(type, email);

    if (!account || !(await bcrypt.compare(password, account.password))) {
      throw new UnauthorizedException('Invalid email or password');
    }

    if (!account.staff?.emailVerifiedAt) {
      throw new UnauthorizedException(
        'Please verify your email before logging in',
      );
    }

    const token = await this.jwtService.signAsync({
      accountId: account.id,
      staffId: account.staffId,
      role: type,
      type,
    });

    return {
      token,
      account: this.toSafeAccount(type, account),
    };
  }

  async update(type: AccountType, id: string, body: Record<string, unknown>) {
    const existing = await this.findAccountById(type, id);

    if (!existing) {
      throw new NotFoundException(`${this.label(type)} account not found`);
    }

    const updates: AccountUpdate = {};

    if (body.name !== undefined) {
      updates.name = this.optionalString(body.name, 'name');
    }

    if (body.email !== undefined) {
      updates.email = this.requiredString(body.email, 'email').toLowerCase();
      this.validateEmail(updates.email);
      await this.ensureEmailAvailable(type, updates.email, {
        accountId: existing.id,
        staffId: existing.staffId,
      });
    }

    if (body.password !== undefined) {
      const password = this.requiredString(body.password, 'password');
      this.validatePassword(password);
      updates.password = await bcrypt.hash(password, this.saltRounds);
    }

    if (!Object.keys(updates).length) {
      return {
        message: `${this.label(type)} updated successfully`,
        account: this.toSafeAccount(type, existing),
      };
    }

    let account = await this.updateAccount(type, id, existing.staffId, updates);

    if (updates.email !== undefined) {
      const emailVerificationSent = await this.createAndSendEmailVerification(
        type,
        account,
      );
      account = (await this.findAccountById(type, id)) ?? account;

      return {
        message: emailVerificationSent
          ? `${this.label(type)} updated successfully`
          : `${this.label(type)} updated successfully, but we could not send the verification email. Please contact support to verify your account.`,
        account: this.toSafeAccount(type, account),
      };
    }

    return {
      message: `${this.label(type)} updated successfully`,
      account: this.toSafeAccount(type, account),
    };
  }

  async updateAuthenticated(
    type: AccountType,
    id: string,
    body: Record<string, unknown>,
    user: AuthTokenPayload,
  ) {
    if (user.type !== type || user.accountId !== id) {
      throw new ForbiddenException('You can only update your own account');
    }

    return this.update(type, id, body);
  }

  async forgotPassword(type: AccountType, body: Record<string, unknown>) {
    const email = this.requiredString(body.email, 'email').toLowerCase();
    this.validateEmail(email);
    const account = await this.findAccountByEmail(type, email);

    if (!account) {
      return { message: this.forgotPasswordMessage };
    }

    const token = randomBytes(32).toString('hex');
    const tokenHash = this.hashToken(token);
    const expiresAt = new Date(Date.now() + this.resetTokenMinutes * 60 * 1000);

    await this.prisma.$transaction([
      this.prisma.passwordResetToken.deleteMany({
        where: {
          staffId: account.staffId,
          type,
        },
      }),
      this.prisma.passwordResetToken.create({
        data: {
          tokenHash,
          type,
          expiresAt,
          staffId: account.staffId,
        },
      }),
    ]);

    try {
      await this.emailService.sendPasswordResetEmail({
        to: account.email,
        name: account.name,
        resetUrl: this.buildResetUrl(token, type),
        type,
      });
    } catch (error) {
      await this.prisma.passwordResetToken.deleteMany({
        where: { tokenHash },
      });
      this.logger.error(
        `Failed to send ${type} password reset email`,
        error instanceof Error ? error.stack : undefined,
      );
    }

    return {
      message: this.forgotPasswordMessage,
    };
  }

  forgotPasswordByType(type: string, body: Record<string, unknown>) {
    return this.forgotPassword(this.parseAccountType(type), body);
  }

  async resetPasswordByType(type: string, body: Record<string, unknown>) {
    return this.resetPassword(this.parseAccountType(type), body);
  }

  async resetPassword(type: AccountType, body: Record<string, unknown>) {
    const token = this.requiredString(body.token, 'token');
    const password = this.requiredString(body.password, 'password');
    this.validateToken(token, 'token');
    this.validatePassword(password);

    const tokenHash = this.hashToken(token);
    const resetToken = await this.prisma.passwordResetToken.findUnique({
      where: { tokenHash },
    });

    if (
      !resetToken ||
      resetToken.type !== type ||
      resetToken.usedAt ||
      resetToken.expiresAt <= new Date()
    ) {
      throw new BadRequestException('Invalid or expired password reset token');
    }

    const account = await this.findAccountByStaffId(type, resetToken.staffId);

    if (!account) {
      throw new BadRequestException('Invalid or expired password reset token');
    }

    const hashedPassword = await bcrypt.hash(password, this.saltRounds);

    await this.prisma.$transaction(async (tx) => {
      const claimed = await tx.passwordResetToken.updateMany({
        where: {
          id: resetToken.id,
          usedAt: null,
          expiresAt: { gt: new Date() },
        },
        data: { usedAt: new Date() },
      });

      if (!claimed.count) {
        throw new BadRequestException(
          'Invalid or expired password reset token',
        );
      }

      await this.updateAccountPassword(type, account.id, hashedPassword, tx);
      await tx.passwordResetToken.delete({ where: { id: resetToken.id } });
    });

    return {
      message: 'Password reset successfully',
    };
  }

  async verifyEmailByType(type: string, body: Record<string, unknown>) {
    return this.verifyEmail(this.parseAccountType(type), body);
  }

  async verifyEmail(type: AccountType, body: Record<string, unknown>) {
    const token = this.requiredString(body.token, 'token');
    this.validateToken(token, 'token');
    const tokenHash = this.hashToken(token);
    const verificationToken =
      await this.prisma.emailVerificationToken.findUnique({
        where: { tokenHash },
      });

    if (
      !verificationToken ||
      verificationToken.type !== type ||
      verificationToken.usedAt ||
      verificationToken.expiresAt <= new Date()
    ) {
      throw new BadRequestException(
        'Invalid or expired email verification token',
      );
    }

    const account = await this.findAccountByStaffId(
      type,
      verificationToken.staffId,
    );

    if (!account) {
      throw new BadRequestException(
        'Invalid or expired email verification token',
      );
    }

    const verifiedAt = new Date();

    const updatedStaff = await this.prisma.$transaction(async (tx) => {
      const claimed = await tx.emailVerificationToken.updateMany({
        where: {
          id: verificationToken.id,
          usedAt: null,
          expiresAt: { gt: new Date() },
        },
        data: { usedAt: verifiedAt },
      });

      if (!claimed.count) {
        throw new BadRequestException(
          'Invalid or expired email verification token',
        );
      }

      const staff = await tx.staff.update({
        where: { id: verificationToken.staffId },
        data: { emailVerifiedAt: verifiedAt },
      });
      await tx.emailVerificationToken.delete({
        where: { id: verificationToken.id },
      });

      return staff;
    });

    return {
      message: 'Email verified successfully',
      account: this.toSafeAccount(type, {
        ...account,
        staff: updatedStaff,
      }),
    };
  }

  private parseRegisterBody(body: Record<string, unknown>): RegisterDto {
    const email = this.requiredString(body.email, 'email').toLowerCase();
    const password = this.requiredString(body.password, 'password');
    const name = this.optionalString(body.name, 'name');

    this.validateEmail(email);
    this.validatePassword(password);

    return { email, password, name };
  }

  private validatePassword(password: string) {
    this.validatePasswordLength(password);

    const strongPassword =
      password.length >= 8 &&
      /[A-Z]/.test(password) &&
      /[a-z]/.test(password) &&
      /\d/.test(password) &&
      /[^A-Za-z0-9]/.test(password);

    if (!strongPassword) {
      throw new BadRequestException(
        'Password must be at least 8 characters and include uppercase, lowercase, number, and special character',
      );
    }
  }

  private validatePasswordLength(password: string) {
    if (password.length > this.maxPasswordLength) {
      throw new BadRequestException('password is too long');
    }
  }

  private validateEmail(email: string) {
    const validEmail =
      email.length <= 254 && /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email);

    if (!validEmail) {
      throw new BadRequestException('email must be a valid email address');
    }
  }

  private validateToken(token: string, field: string) {
    if (!/^[a-f0-9]{64}$/i.test(token)) {
      throw new BadRequestException(`${field} is invalid`);
    }
  }

  private async ensureEmailAvailable(
    type: AccountType,
    email: string,
    current?: { accountId: string; staffId: string },
  ) {
    const [account, staff] = await Promise.all([
      this.findAccountByEmail(type, email),
      this.prisma.staff.findUnique({ where: { email } }),
    ]);

    if (account && account.id !== current?.accountId) {
      throw new ConflictException(
        `Email already exists in ${this.label(type)} accounts`,
      );
    }

    if (staff && staff.id !== current?.staffId) {
      throw new ConflictException('Email already exists in Staff records');
    }
  }

  private createAccount(
    type: AccountType,
    data: { email: string; name?: string | null; password: string },
  ): Promise<AccountWithStaff> {
    const staff = {
      create: {
        email: data.email,
        name: data.name,
        role: type,
      },
    };

    switch (type) {
      case 'owner':
        return this.prisma.owner.create({
          data: { ...data, staff },
          include: { staff: true },
        });
      case 'partner':
        return this.prisma.partner.create({
          data: { ...data, staff },
          include: { staff: true },
        });
      case 'manager':
        return this.prisma.manager.create({
          data: { ...data, staff },
          include: { staff: true },
        });
      case 'employee':
        return this.prisma.employee.create({
          data: { ...data, staff },
          include: { staff: true },
        });
    }
  }

  private findAccountByEmail(
    type: AccountType,
    email: string,
  ): Promise<AccountWithStaff | null> {
    switch (type) {
      case 'owner':
        return this.prisma.owner.findUnique({
          where: { email },
          include: { staff: true },
        });
      case 'partner':
        return this.prisma.partner.findUnique({
          where: { email },
          include: { staff: true },
        });
      case 'manager':
        return this.prisma.manager.findUnique({
          where: { email },
          include: { staff: true },
        });
      case 'employee':
        return this.prisma.employee.findUnique({
          where: { email },
          include: { staff: true },
        });
    }
  }

  private findAccountById(
    type: AccountType,
    id: string,
  ): Promise<AccountWithStaff | null> {
    switch (type) {
      case 'owner':
        return this.prisma.owner.findUnique({
          where: { id },
          include: { staff: true },
        });
      case 'partner':
        return this.prisma.partner.findUnique({
          where: { id },
          include: { staff: true },
        });
      case 'manager':
        return this.prisma.manager.findUnique({
          where: { id },
          include: { staff: true },
        });
      case 'employee':
        return this.prisma.employee.findUnique({
          where: { id },
          include: { staff: true },
        });
    }
  }

  private findAccountByStaffId(
    type: AccountType,
    staffId: string,
  ): Promise<AccountWithStaff | null> {
    switch (type) {
      case 'owner':
        return this.prisma.owner.findUnique({
          where: { staffId },
          include: { staff: true },
        });
      case 'partner':
        return this.prisma.partner.findUnique({
          where: { staffId },
          include: { staff: true },
        });
      case 'manager':
        return this.prisma.manager.findUnique({
          where: { staffId },
          include: { staff: true },
        });
      case 'employee':
        return this.prisma.employee.findUnique({
          where: { staffId },
          include: { staff: true },
        });
    }
  }

  private async updateAccount(
    type: AccountType,
    id: string,
    staffId: string,
    updates: AccountUpdate,
  ): Promise<AccountWithStaff> {
    const accountData: AccountUpdate = {};
    const staffData: { email?: string; name?: string | null } = {};

    if (updates.email !== undefined) {
      accountData.email = updates.email;
      staffData.email = updates.email;
    }

    if (updates.name !== undefined) {
      accountData.name = updates.name;
      staffData.name = updates.name;
    }

    if (updates.password !== undefined) {
      accountData.password = updates.password;
    }

    return this.prisma.$transaction(async (tx) => {
      if (Object.keys(staffData).length) {
        await tx.staff.update({
          where: { id: staffId },
          data: staffData,
        });
      }

      switch (type) {
        case 'owner':
          return tx.owner.update({
            where: { id },
            data: accountData,
            include: { staff: true },
          });
        case 'partner':
          return tx.partner.update({
            where: { id },
            data: accountData,
            include: { staff: true },
          });
        case 'manager':
          return tx.manager.update({
            where: { id },
            data: accountData,
            include: { staff: true },
          });
        case 'employee':
          return tx.employee.update({
            where: { id },
            data: accountData,
            include: { staff: true },
          });
      }
    });
  }

  private updateAccountPassword(
    type: AccountType,
    id: string,
    password: string,
    tx: TransactionClient,
  ) {
    switch (type) {
      case 'owner':
        return tx.owner.update({ where: { id }, data: { password } });
      case 'partner':
        return tx.partner.update({ where: { id }, data: { password } });
      case 'manager':
        return tx.manager.update({ where: { id }, data: { password } });
      case 'employee':
        return tx.employee.update({ where: { id }, data: { password } });
    }
  }

  private async createAndSendEmailVerification(
    type: AccountType,
    account: AccountWithStaff,
  ) {
    const token = randomBytes(32).toString('hex');
    const tokenHash = this.hashToken(token);
    const expiresAt = new Date(
      Date.now() + this.emailVerificationTokenHours * 60 * 60 * 1000,
    );

    await this.prisma.$transaction([
      this.prisma.emailVerificationToken.deleteMany({
        where: {
          staffId: account.staffId,
          type,
        },
      }),
      this.prisma.emailVerificationToken.create({
        data: {
          tokenHash,
          type,
          expiresAt,
          staffId: account.staffId,
        },
      }),
      this.prisma.staff.update({
        where: { id: account.staffId },
        data: { emailVerifiedAt: null },
      }),
    ]);

    try {
      await this.emailService.sendEmailVerificationEmail({
        to: account.email,
        name: account.name,
        verificationUrl: this.buildEmailVerificationUrl(token, type),
        type,
      });

      return true;
    } catch (error) {
      this.logger.error(
        `Failed to send ${type} email verification email`,
        error instanceof Error ? error.stack : undefined,
      );

      return false;
    }
  }

  private hashToken(token: string) {
    return createHash('sha256').update(token).digest('hex');
  }

  private buildResetUrl(token: string, type: AccountType) {
    const frontendUrl = process.env.FRONTEND_URL ?? 'http://localhost:3000';
    const url = new URL('/reset-password', frontendUrl);
    url.searchParams.set('token', token);
    url.searchParams.set('type', type);

    return url.toString();
  }

  private buildEmailVerificationUrl(token: string, type: AccountType) {
    const frontendUrl = this.getBackofficeFrontendUrl();
    const url = new URL('/verify-email', frontendUrl);
    url.searchParams.set('token', token);
    url.searchParams.set('type', type);

    this.logger.log(
      `Email verification frontend URL resolved base=${frontendUrl} type=${type}`,
    );

    return url.toString();
  }

  private getBackofficeFrontendUrl() {
    const configuredUrl = this.optionalConfigString('BACKOFFICE_FRONTEND_URL');
    const nodeEnv = this.optionalConfigString('NODE_ENV') ?? '(unset)';

    if (configuredUrl) {
      return configuredUrl;
    }

    if (nodeEnv === 'development') {
      this.logger.warn(
        'BACKOFFICE_FRONTEND_URL is missing; using development fallback http://localhost:3000',
      );
      return 'http://localhost:3000';
    }

    throw new ServiceUnavailableException(
      'Backoffice frontend URL is not configured',
    );
  }

  private toSafeAccount(type: AccountType, account: AccountWithStaff) {
    const { staff, ...safeAccount } = account;
    delete (safeAccount as Partial<AccountWithStaff>).password;

    return {
      ...safeAccount,
      staff: staff
        ? {
            id: staff.id,
            email: staff.email,
            name: staff.name,
            role: staff.role,
            emailVerifiedAt: staff.emailVerifiedAt,
          }
        : undefined,
      role: staff?.role ?? type,
      emailVerified: Boolean(staff?.emailVerifiedAt),
      type,
    };
  }

  private requiredString(value: unknown, field: string) {
    if (typeof value !== 'string' || !value.trim()) {
      throw new BadRequestException(`${field} is required`);
    }

    return value.trim();
  }

  private optionalString(value: unknown, field: string) {
    if (value === undefined) {
      return undefined;
    }

    if (value === null) {
      return null;
    }

    if (typeof value !== 'string') {
      throw new BadRequestException(`${field} must be a string`);
    }

    return value.trim() || null;
  }

  private optionalConfigString(key: string) {
    const value = this.configService.get<string>(key);
    return value?.trim() || undefined;
  }

  private label(type: AccountType) {
    return type.charAt(0).toUpperCase() + type.slice(1);
  }

  private parseAccountType(type: string): AccountType {
    if (this.isAccountType(type)) {
      return type;
    }

    throw new BadRequestException(
      'type must be one of owner, partner, manager, employee',
    );
  }

  private isAccountType(type: string): type is AccountType {
    return ['owner', 'partner', 'manager', 'employee'].includes(type);
  }
}

type AccountType = 'owner' | 'partner' | 'manager' | 'employee';

interface RegisterDto {
  email: string;
  password: string;
  name?: string | null;
}

interface AccountUpdate {
  email?: string;
  name?: string | null;
  password?: string;
}

interface AccountWithStaff {
  id: string;
  email: string;
  password: string;
  name: string | null;
  staffId: string;
  createdAt: Date;
  permissions?: unknown;
  isActive?: boolean;
  staff?: {
    id: string;
    email: string;
    name: string | null;
    role: StaffRole;
    emailVerifiedAt: Date | null;
  };
}

type TransactionClient = Prisma.TransactionClient;
