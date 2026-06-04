import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { RegisterStatus, StaffRole, StorePermissionKey } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import { AuthTokenPayload } from '../auth/strategies/jwt.strategy';
import { PosAccessService } from '../common/pos-access.service';
import { PrismaService } from '../prisma.service';

const ACTIVATION_CODE_TTL_MS = 15 * 60 * 1000;

@Injectable()
export class RegistersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: PosAccessService,
  ) {}

  async create(
    storeId: string,
    body: Record<string, unknown>,
    user: AuthTokenPayload,
  ) {
    await this.access.ensureStoreAccess(
      storeId,
      user,
      StorePermissionKey.manage_registers,
    );
    const dto = this.parseRegisterCreate(body);

    const register = await this.prisma.register.create({
      data: {
        storeId,
        name: dto.name,
        registerNumber: dto.registerNumber,
        description: dto.description,
      },
    });

    return this.toRegisterResponse(register);
  }

  async list(storeId: string, user: AuthTokenPayload) {
    await this.ensureStoreMembership(storeId, user);

    const registers = await this.prisma.register.findMany({
      where: { storeId },
      orderBy: { createdAt: 'asc' },
    });

    return registers.map((register) => this.toRegisterResponse(register));
  }

  async findOne(storeId: string, registerId: string, user: AuthTokenPayload) {
    await this.ensureStoreMembership(storeId, user);

    return this.toRegisterResponse(
      await this.findRegisterOrThrow(storeId, registerId),
    );
  }

  async update(
    storeId: string,
    registerId: string,
    body: Record<string, unknown>,
    user: AuthTokenPayload,
  ) {
    await this.access.ensureStoreAccess(
      storeId,
      user,
      StorePermissionKey.manage_registers,
    );
    await this.findRegisterOrThrow(storeId, registerId);
    const dto = this.parseRegisterUpdate(body);

    if (!Object.keys(dto).length) {
      throw new BadRequestException('At least one register field is required');
    }

    const register = await this.prisma.register.update({
      where: { id: registerId },
      data: dto,
    });

    return this.toRegisterResponse(register);
  }

  async revokeRegister(
    storeId: string,
    registerId: string,
    user: AuthTokenPayload,
  ) {
    await this.access.ensureStoreAccess(
      storeId,
      user,
      StorePermissionKey.manage_registers,
    );
    await this.findRegisterOrThrow(storeId, registerId);
    const now = new Date();

    const register = await this.prisma.$transaction(async (tx) => {
      await tx.registerDevice.updateMany({
        where: { storeId, registerId, isActive: true },
        data: { isActive: false, revokedAt: now },
      });

      return tx.register.update({
        where: { id: registerId },
        data: { status: RegisterStatus.revoked },
      });
    });

    return this.toRegisterResponse(register);
  }

  async revokeDevice(
    storeId: string,
    registerId: string,
    deviceId: string,
    user: AuthTokenPayload,
  ) {
    await this.access.ensureStoreAccess(
      storeId,
      user,
      StorePermissionKey.manage_registers,
    );
    await this.findRegisterOrThrow(storeId, registerId);

    const result = await this.prisma.registerDevice.updateMany({
      where: { id: deviceId, storeId, registerId, isActive: true },
      data: { isActive: false, revokedAt: new Date() },
    });

    if (result.count !== 1) {
      throw new NotFoundException('Register device not found');
    }

    return { success: true };
  }

  async createActivationCode(
    storeId: string,
    registerId: string,
    user: AuthTokenPayload,
  ) {
    await this.access.ensureStoreAccess(
      storeId,
      user,
      StorePermissionKey.manage_registers,
    );
    const register = await this.findRegisterOrThrow(storeId, registerId);

    if (register.status === RegisterStatus.revoked) {
      throw new BadRequestException('Revoked registers cannot be activated');
    }

    const code = this.generateActivationCode();
    const codeHash = await bcrypt.hash(code, 12);
    const now = new Date();
    const expiresAt = new Date(now.getTime() + ACTIVATION_CODE_TTL_MS);

    await this.prisma.$transaction(async (tx) => {
      await tx.registerActivationCode.updateMany({
        where: {
          registerId,
          usedAt: null,
          expiresAt: { gt: now },
        },
        data: { usedAt: now },
      });

      await tx.registerActivationCode.create({
        data: {
          registerId,
          storeId,
          codeHash,
          expiresAt,
          createdByStaffId: user.staffId,
        },
      });
    });

    return { code, expiresAt };
  }

  async activate(body: Record<string, unknown>) {
    const dto = this.parseActivationBody(body);
    const now = new Date();
    const candidates = await this.prisma.registerActivationCode.findMany({
      where: {
        usedAt: null,
        expiresAt: { gt: now },
      },
      include: {
        register: true,
        store: {
          select: {
            id: true,
            name: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });

    let activation = null as (typeof candidates)[number] | null;
    for (const candidate of candidates) {
      if (await bcrypt.compare(dto.code, candidate.codeHash)) {
        activation = candidate;
        break;
      }
    }

    if (!activation) {
      throw new UnauthorizedException('Invalid or expired activation code');
    }

    if (activation.storeId !== activation.register.storeId) {
      throw new BadRequestException('Activation code store mismatch');
    }

    if (activation.register.status === RegisterStatus.revoked) {
      throw new ForbiddenException('Register is revoked');
    }

    const registerToken = this.generateRegisterToken();
    const tokenHash = this.hashToken(registerToken);

    const result = await this.prisma.$transaction(async (tx) => {
      const updateCode = await tx.registerActivationCode.updateMany({
        where: {
          id: activation.id,
          usedAt: null,
          expiresAt: { gt: new Date() },
        },
        data: { usedAt: new Date() },
      });

      if (updateCode.count !== 1) {
        throw new UnauthorizedException('Activation code has already been used');
      }

      const register = await tx.register.update({
        where: { id: activation.registerId },
        data: {
          status: RegisterStatus.active,
          activatedAt: activation.register.activatedAt ?? new Date(),
          lastSeenAt: new Date(),
          deviceName: dto.deviceName,
        },
      });

      await tx.registerDevice.create({
        data: {
          registerId: activation.registerId,
          storeId: activation.storeId,
          deviceName: dto.deviceName,
          deviceFingerprint: dto.deviceFingerprint,
          deviceTokenHash: tokenHash,
          lastSeenAt: new Date(),
        },
      });

      return register;
    });

    return {
      registerToken,
      register: this.toRegisterResponse(result),
      store: activation.store,
    };
  }

  async heartbeat(context: RegisterDeviceContext) {
    const now = new Date();

    await this.prisma.$transaction([
      this.prisma.register.update({
        where: { id: context.register.id },
        data: { lastSeenAt: now },
      }),
      this.prisma.registerDevice.update({
        where: { id: context.registerDevice.id },
        data: { lastSeenAt: now },
      }),
    ]);

    return { success: true };
  }

  async authenticateRegisterToken(
    token: string,
  ): Promise<RegisterDeviceContext> {
    const tokenHash = this.hashToken(token);
    const registerDevice = await this.prisma.registerDevice.findUnique({
      where: { deviceTokenHash: tokenHash },
      include: {
        register: true,
        store: true,
      },
    });

    if (
      !registerDevice ||
      !registerDevice.isActive ||
      registerDevice.revokedAt ||
      registerDevice.register.status === RegisterStatus.revoked
    ) {
      throw new UnauthorizedException('Invalid register token');
    }

    if (registerDevice.register.status !== RegisterStatus.active) {
      throw new UnauthorizedException('Register is not active');
    }

    if (registerDevice.storeId !== registerDevice.register.storeId) {
      throw new UnauthorizedException('Register token store mismatch');
    }

    return {
      register: registerDevice.register,
      registerDevice,
      store: registerDevice.store,
    };
  }

  async validateRegisterTokenForStore(token: string, storeId: string) {
    const context = await this.authenticateRegisterToken(token);

    if (context.store.id !== storeId || context.register.storeId !== storeId) {
      throw new ForbiddenException('Register does not belong to this store');
    }

    return context;
  }

  private async ensureStoreMembership(
    storeId: string,
    user: AuthTokenPayload,
  ) {
    const store = await this.prisma.store.findFirst({
      where: { id: storeId, isActive: true },
      select: {
        id: true,
        ownerId: true,
      },
    });

    if (!store) {
      throw new NotFoundException('Store not found');
    }

    if (user.type === StaffRole.owner && user.accountId === store.ownerId) {
      return store;
    }

    const assignment = await this.prisma.storeStaff.findUnique({
      where: {
        storeId_staffId: {
          storeId,
          staffId: user.staffId,
        },
      },
      select: { id: true },
    });

    if (!assignment) {
      throw new ForbiddenException('You do not have access to this store');
    }

    return store;
  }

  private async findRegisterOrThrow(storeId: string, registerId: string) {
    const register = await this.prisma.register.findFirst({
      where: {
        id: this.requiredString(registerId, 'registerId'),
        storeId,
      },
    });

    if (!register) {
      throw new NotFoundException('Register not found');
    }

    return register;
  }

  private parseRegisterCreate(body: Record<string, unknown>) {
    return {
      name: this.requiredString(body.name, 'name'),
      registerNumber: this.requiredString(
        body.registerNumber ?? body.code,
        'registerNumber',
      ),
      description: this.optionalString(body.description, 'description'),
    };
  }

  private parseRegisterUpdate(body: Record<string, unknown>) {
    const dto: RegisterUpdateDto = {};

    if (body.name !== undefined) {
      dto.name = this.requiredString(body.name, 'name');
    }
    if (body.registerNumber !== undefined || body.code !== undefined) {
      dto.registerNumber = this.requiredString(
        body.registerNumber ?? body.code,
        'registerNumber',
      );
    }
    if (body.description !== undefined) {
      dto.description = this.optionalString(body.description, 'description');
    }
    if (body.deviceName !== undefined) {
      dto.deviceName = this.optionalString(body.deviceName, 'deviceName');
    }
    if (body.status !== undefined) {
      dto.status = this.requiredRegisterStatus(body.status, 'status');
    }

    return dto;
  }

  private parseActivationBody(body: Record<string, unknown>) {
    const code = this.requiredString(body.code, 'code');

    if (!/^\d{6}$/.test(code)) {
      throw new BadRequestException('code must be a 6-digit number');
    }

    return {
      code,
      deviceName: this.optionalString(body.deviceName, 'deviceName'),
      deviceFingerprint: this.optionalString(
        body.deviceFingerprint,
        'deviceFingerprint',
      ),
    };
  }

  private requiredRegisterStatus(value: unknown, field: string) {
    if (
      typeof value !== 'string' ||
      !Object.values(RegisterStatus).includes(value as RegisterStatus)
    ) {
      throw new BadRequestException(
        `${field} must be one of ${Object.values(RegisterStatus).join(', ')}`,
      );
    }

    return value as RegisterStatus;
  }

  private requiredString(value: unknown, field: string) {
    if (typeof value !== 'string' || !value.trim()) {
      throw new BadRequestException(`${field} is required`);
    }

    return value.trim();
  }

  private optionalString(value: unknown, field: string) {
    if (value === undefined || value === null) {
      return null;
    }

    if (typeof value !== 'string') {
      throw new BadRequestException(`${field} must be a string`);
    }

    return value.trim() || null;
  }

  private generateActivationCode() {
    return String(randomBytes(4).readUInt32BE(0) % 1_000_000).padStart(6, '0');
  }

  private generateRegisterToken() {
    return `reg_${randomBytes(32).toString('base64url')}`;
  }

  private hashToken(token: string) {
    const tokenHash = createHash('sha256').update(token).digest('hex');
    const repeatHash = createHash('sha256').update(token).digest('hex');
    timingSafeEqual(Buffer.from(tokenHash), Buffer.from(repeatHash));

    return tokenHash;
  }

  private toRegisterResponse(register: RegisterResponseInput) {
    return {
      id: register.id,
      storeId: register.storeId,
      name: register.name,
      registerNumber: register.registerNumber,
      description: register.description,
      deviceName: register.deviceName,
      status: register.status,
      activatedAt: register.activatedAt,
      lastSeenAt: register.lastSeenAt,
      createdAt: register.createdAt,
      updatedAt: register.updatedAt,
    };
  }
}

export type RegisterDeviceContext = {
  register: RegisterResponseInput;
  registerDevice: {
    id: string;
    registerId: string;
    storeId: string;
    isActive: boolean;
    revokedAt: Date | null;
  };
  store: {
    id: string;
    name: string;
  };
};

export type RegisterDeviceRequest = {
  registerContext: RegisterDeviceContext;
};

type RegisterUpdateDto = {
  name?: string;
  registerNumber?: string;
  description?: string | null;
  deviceName?: string | null;
  status?: RegisterStatus;
};

type RegisterResponseInput = {
  id: string;
  storeId: string;
  name: string;
  registerNumber: string;
  description: string | null;
  deviceName: string | null;
  status: RegisterStatus;
  activatedAt: Date | null;
  lastSeenAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};
