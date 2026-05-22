import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AuthTokenPayload } from '../auth/strategies/jwt.strategy';
import { PosAccessService } from '../common/pos-access.service';
import { PrismaService } from '../prisma.service';

@Injectable()
export class DepartmentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: PosAccessService,
  ) {}

  async create(body: Record<string, unknown>, user: AuthTokenPayload) {
    const dto = this.parseCreateBody(body);
    await this.access.ensureStoreAccess(
      dto.storeId,
      user,
      'manage_departments',
    );

    try {
      return await this.prisma.department.create({ data: dto });
    } catch (error) {
      this.handleUniqueName(error);
      throw error;
    }
  }

  async listByStore(storeId: string, user: AuthTokenPayload) {
    await this.access.ensureStoreAccess(storeId, user, 'manage_departments');

    return this.prisma.department.findMany({
      where: { storeId },
      orderBy: { name: 'asc' },
    });
  }

  async update(
    id: string,
    body: Record<string, unknown>,
    user: AuthTokenPayload,
  ) {
    const department = await this.findOrThrow(id);
    await this.access.ensureStoreAccess(
      department.storeId,
      user,
      'manage_departments',
    );
    const updates = this.parseUpdateBody(body);

    try {
      return await this.prisma.department.update({
        where: { id },
        data: updates,
      });
    } catch (error) {
      this.handleUniqueName(error);
      throw error;
    }
  }

  async remove(id: string, user: AuthTokenPayload) {
    const department = await this.findOrThrow(id);
    await this.access.ensureStoreAccess(
      department.storeId,
      user,
      'manage_departments',
    );

    try {
      return await this.prisma.department.delete({ where: { id } });
    } catch (error) {
      this.handleDeleteConstraint(error, 'Department is used by products');
      throw error;
    }
  }

  private async findOrThrow(id: string) {
    const department = await this.prisma.department.findUnique({
      where: { id },
    });

    if (!department) {
      throw new NotFoundException('Department not found');
    }

    return department;
  }

  private parseCreateBody(body: Record<string, unknown>) {
    return {
      storeId: this.requiredString(body.storeId, 'storeId'),
      name: this.requiredString(body.name, 'name'),
      defaultAllowEbt: this.optionalBoolean(
        body.defaultAllowEbt,
        'defaultAllowEbt',
        false,
      ),
    };
  }

  private parseUpdateBody(
    body: Record<string, unknown>,
  ): Prisma.DepartmentUpdateInput {
    const updates: Prisma.DepartmentUpdateInput = {};

    if (body.name !== undefined) {
      updates.name = this.requiredString(body.name, 'name');
    }

    if (body.defaultAllowEbt !== undefined) {
      updates.defaultAllowEbt = this.requiredBoolean(
        body.defaultAllowEbt,
        'defaultAllowEbt',
      );
    }

    return updates;
  }

  private requiredString(value: unknown, field: string) {
    if (typeof value !== 'string' || !value.trim()) {
      throw new BadRequestException(`${field} is required`);
    }

    return value.trim();
  }

  private requiredBoolean(value: unknown, field: string) {
    if (typeof value !== 'boolean') {
      throw new BadRequestException(`${field} must be a boolean`);
    }

    return value;
  }

  private optionalBoolean(value: unknown, field: string, fallback: boolean) {
    if (value === undefined || value === null) {
      return fallback;
    }

    return this.requiredBoolean(value, field);
  }

  private handleUniqueName(error: unknown) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002'
    ) {
      throw new ConflictException(
        'A department with that name already exists for this store',
      );
    }
  }

  private handleDeleteConstraint(error: unknown, message: string) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2003'
    ) {
      throw new BadRequestException(message);
    }
  }
}
