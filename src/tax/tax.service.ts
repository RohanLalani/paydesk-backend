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
export class TaxService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: PosAccessService,
  ) {}

  async create(body: Record<string, unknown>, user: AuthTokenPayload) {
    const dto = this.parseCreateBody(body);
    await this.access.ensureStoreAccess(dto.storeId, user, 'manage_taxes');

    try {
      return await this.prisma.tax.create({ data: dto });
    } catch (error) {
      this.handleUniqueName(error);
      throw error;
    }
  }

  async listByStore(storeId: string, user: AuthTokenPayload) {
    await this.access.ensureStoreAccess(storeId, user, 'manage_taxes');

    return this.prisma.tax.findMany({
      where: { storeId },
      orderBy: { name: 'asc' },
    });
  }

  async update(
    id: string,
    body: Record<string, unknown>,
    user: AuthTokenPayload,
  ) {
    const tax = await this.findOrThrow(id);
    await this.access.ensureStoreAccess(tax.storeId, user, 'manage_taxes');
    const updates = this.parseUpdateBody(body);

    try {
      return await this.prisma.tax.update({ where: { id }, data: updates });
    } catch (error) {
      this.handleUniqueName(error);
      throw error;
    }
  }

  async remove(id: string, user: AuthTokenPayload) {
    const tax = await this.findOrThrow(id);
    await this.access.ensureStoreAccess(tax.storeId, user, 'manage_taxes');

    try {
      return await this.prisma.tax.delete({ where: { id } });
    } catch (error) {
      this.handleDeleteConstraint(error, 'Tax is used by products');
      throw error;
    }
  }

  private async findOrThrow(id: string) {
    const tax = await this.prisma.tax.findUnique({ where: { id } });

    if (!tax) {
      throw new NotFoundException('Tax not found');
    }

    return tax;
  }

  private parseCreateBody(body: Record<string, unknown>) {
    return {
      storeId: this.requiredString(body.storeId, 'storeId'),
      name: this.requiredString(body.name, 'name'),
      rate: this.requiredNumber(body.rate, 'rate'),
    };
  }

  private parseUpdateBody(
    body: Record<string, unknown>,
  ): Prisma.TaxUpdateInput {
    const updates: Prisma.TaxUpdateInput = {};

    if (body.name !== undefined) {
      updates.name = this.requiredString(body.name, 'name');
    }

    if (body.rate !== undefined) {
      updates.rate = this.requiredNumber(body.rate, 'rate');
    }

    return updates;
  }

  private requiredString(value: unknown, field: string) {
    if (typeof value !== 'string' || !value.trim()) {
      throw new BadRequestException(`${field} is required`);
    }

    return value.trim();
  }

  private requiredNumber(value: unknown, field: string) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new BadRequestException(`${field} must be a number`);
    }

    if (value < 0) {
      throw new BadRequestException(`${field} must be zero or greater`);
    }

    return value;
  }

  private handleUniqueName(error: unknown) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002'
    ) {
      throw new ConflictException(
        'A tax with that name already exists for this store',
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
