import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { StaffRole } from '@prisma/client';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { PrismaService } from '../../prisma.service';
import { getRequiredJwtSecret } from '../auth.config';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    configService: ConfigService,
    private readonly prisma: PrismaService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: getRequiredJwtSecret(configService),
    });
  }

  async validate(payload: AuthTokenPayload): Promise<AuthTokenPayload> {
    if (
      !payload?.accountId ||
      !payload.staffId ||
      !this.isStaffRole(payload.type)
    ) {
      throw new UnauthorizedException('Invalid token payload');
    }

    const staff = await this.prisma.staff.findUnique({
      where: { id: payload.staffId },
      select: {
        id: true,
        role: true,
        emailVerifiedAt: true,
        owner: { select: { id: true } },
        partner: { select: { id: true } },
        manager: { select: { id: true } },
        employee: { select: { id: true, isActive: true } },
      },
    });

    if (!staff?.emailVerifiedAt || staff.role !== payload.type) {
      throw new UnauthorizedException('Invalid token payload');
    }

    const account = this.getAccountForType(staff, payload.type);

    if (!account || account.id !== payload.accountId) {
      throw new UnauthorizedException('Invalid token payload');
    }

    if (payload.type === StaffRole.employee && !staff.employee?.isActive) {
      throw new UnauthorizedException('Employee account is inactive');
    }

    return {
      accountId: account.id,
      staffId: staff.id,
      role: staff.role,
      type: staff.role,
    };
  }

  private isStaffRole(value: unknown): value is StaffRole {
    return (
      value === StaffRole.owner ||
      value === StaffRole.partner ||
      value === StaffRole.manager ||
      value === StaffRole.employee
    );
  }

  private getAccountForType(
    staff: JwtStaff,
    type: StaffRole,
  ): { id: string } | null {
    switch (type) {
      case StaffRole.owner:
        return staff.owner;
      case StaffRole.partner:
        return staff.partner;
      case StaffRole.manager:
        return staff.manager;
      case StaffRole.employee:
        return staff.employee;
    }
  }
}

export interface AuthTokenPayload {
  accountId: string;
  staffId: string;
  role: StaffRole;
  type: StaffRole;
}

type JwtStaff = {
  owner: { id: string } | null;
  partner: { id: string } | null;
  manager: { id: string } | null;
  employee: { id: string; isActive: boolean } | null;
};
