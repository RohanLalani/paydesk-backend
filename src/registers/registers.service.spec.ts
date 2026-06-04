import { UnauthorizedException } from '@nestjs/common';
import { RegisterStatus, StaffRole, StorePermissionKey } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { createHash } from 'crypto';
import { PosAccessService } from '../common/pos-access.service';
import { PrismaService } from '../prisma.service';
import { RegistersService } from './registers.service';

describe('RegistersService', () => {
  let service: RegistersService;
  let prisma: MockPrisma;
  let access: { ensureStoreAccess: jest.Mock };

  const user = {
    accountId: 'owner-1',
    staffId: 'staff-owner-1',
    role: StaffRole.owner,
    type: StaffRole.owner,
  };

  beforeEach(() => {
    prisma = createMockPrisma();
    access = { ensureStoreAccess: jest.fn().mockResolvedValue(undefined) };
    service = new RegistersService(
      prisma as unknown as PrismaService,
      access as unknown as PosAccessService,
    );
  });

  it('creates one-time activation codes without storing the plain code', async () => {
    const result = await service.createActivationCode(
      'store-1',
      'register-1',
      user,
    );

    expect(access.ensureStoreAccess).toHaveBeenCalledWith(
      'store-1',
      user,
      StorePermissionKey.manage_registers,
    );
    expect(result.code).toMatch(/^\d{6}$/);
    expect(prisma.registerActivationCode.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        registerId: 'register-1',
        storeId: 'store-1',
        createdByStaffId: 'staff-owner-1',
        codeHash: expect.any(String),
      }),
    });

    const { codeHash } = prisma.registerActivationCode.create.mock.calls[0][0]
      .data;
    expect(codeHash).not.toBe(result.code);
    await expect(bcrypt.compare(result.code, codeHash)).resolves.toBe(true);
  });

  it('rejects invalid or expired activation codes', async () => {
    prisma.registerActivationCode.findMany.mockResolvedValue([]);

    await expect(
      service.activate({
        code: '482913',
        deviceName: 'Front Counter Terminal',
      }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('activates a register and stores only the register token hash', async () => {
    const codeHash = await bcrypt.hash('482913', 4);
    prisma.registerActivationCode.findMany.mockResolvedValue([
      {
        id: 'activation-1',
        registerId: 'register-1',
        storeId: 'store-1',
        codeHash,
        expiresAt: new Date(Date.now() + 60_000),
        usedAt: null,
        register: registerFixture(),
        store: { id: 'store-1', name: 'Main Store' },
      },
    ]);

    const result = await service.activate({
      code: '482913',
      deviceName: 'Front Counter Terminal',
      deviceFingerprint: 'fingerprint-1',
    });

    expect(result.registerToken).toMatch(/^reg_/);
    expect(result.register.status).toBe(RegisterStatus.active);
    expect(prisma.registerActivationCode.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'activation-1',
        usedAt: null,
        expiresAt: { gt: expect.any(Date) },
      },
      data: { usedAt: expect.any(Date) },
    });
    expect(prisma.registerDevice.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        registerId: 'register-1',
        storeId: 'store-1',
        deviceName: 'Front Counter Terminal',
        deviceFingerprint: 'fingerprint-1',
        deviceTokenHash: hashToken(result.registerToken),
      }),
    });
  });
});

function createMockPrisma(): MockPrisma {
  const prisma = {
    register: {
      findFirst: jest.fn().mockResolvedValue(registerFixture()),
      update: jest.fn().mockResolvedValue({
        ...registerFixture(),
        status: RegisterStatus.active,
        activatedAt: new Date('2026-06-03T12:00:00.000Z'),
        lastSeenAt: new Date('2026-06-03T12:00:00.000Z'),
        deviceName: 'Front Counter Terminal',
      }),
    },
    registerActivationCode: {
      findMany: jest.fn(),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      create: jest.fn().mockResolvedValue({}),
    },
    registerDevice: {
      create: jest.fn().mockResolvedValue({}),
    },
    $transaction: jest.fn(async (input) => {
      if (Array.isArray(input)) {
        return Promise.all(input);
      }

      return input(prisma);
    }),
  };

  return prisma;
}

function registerFixture() {
  return {
    id: 'register-1',
    storeId: 'store-1',
    name: 'Front Register 1',
    registerNumber: 'REG-001',
    description: null,
    deviceName: null,
    status: RegisterStatus.inactive,
    activatedAt: null,
    lastSeenAt: null,
    createdAt: new Date('2026-06-03T12:00:00.000Z'),
    updatedAt: new Date('2026-06-03T12:00:00.000Z'),
  };
}

function hashToken(token: string) {
  return createHash('sha256').update(token).digest('hex');
}

type MockPrisma = Record<string, any>;
