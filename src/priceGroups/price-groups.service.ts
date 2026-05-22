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
export class PriceGroupService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: PosAccessService,
  ) {}

  async create(body: Record<string, unknown>, user: AuthTokenPayload) {
    const dto = this.parseCreateBody(body);
    await this.access.ensureStoreAccess(
      dto.storeId,
      user,
      'manage_price_groups',
    );

    try {
      return await this.prisma.priceGroup.create({ data: dto });
    } catch (error) {
      this.handleUniqueName(error);
      throw error;
    }
  }

  async listByStore(storeId: string, user: AuthTokenPayload) {
    await this.access.ensureStoreAccess(storeId, user, 'manage_price_groups');

    return this.prisma.priceGroup.findMany({
      where: { storeId },
      orderBy: { name: 'asc' },
    });
  }

  async update(
    id: string,
    body: Record<string, unknown>,
    user: AuthTokenPayload,
  ) {
    const priceGroup = await this.findOrThrow(id);
    await this.access.ensureStoreAccess(
      priceGroup.storeId,
      user,
      'manage_price_groups',
    );
    const updates = this.parseUpdateBody(body);

    try {
      return await this.prisma.priceGroup.update({
        where: { id },
        data: updates,
      });
    } catch (error) {
      this.handleUniqueName(error);
      throw error;
    }
  }

  async remove(id: string, user: AuthTokenPayload) {
    const priceGroup = await this.findOrThrow(id);
    await this.access.ensureStoreAccess(
      priceGroup.storeId,
      user,
      'manage_price_groups',
    );

    try {
      return await this.prisma.priceGroup.delete({ where: { id } });
    } catch (error) {
      this.handleDeleteConstraint(error, 'Price group is used by products');
      throw error;
    }
  }

  private async findOrThrow(id: string) {
    const priceGroup = await this.prisma.priceGroup.findUnique({
      where: { id },
    });

    if (!priceGroup) {
      throw new NotFoundException('Price group not found');
    }

    return priceGroup;
  }

  private parseCreateBody(body: Record<string, unknown>) {
    return {
      storeId: this.requiredString(body.storeId, 'storeId'),
      name: this.requiredString(body.name, 'name'),
      description: this.optionalString(body.description, 'description'),
    };
  }

  private parseUpdateBody(
    body: Record<string, unknown>,
  ): Prisma.PriceGroupUpdateInput {
    const updates: Prisma.PriceGroupUpdateInput = {};

    if (body.name !== undefined) {
      updates.name = this.requiredString(body.name, 'name');
    }

    if (body.description !== undefined) {
      updates.description = this.optionalString(
        body.description,
        'description',
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

  private optionalString(value: unknown, field: string) {
    if (value === undefined || value === null) {
      return null;
    }

    if (typeof value !== 'string') {
      throw new BadRequestException(`${field} must be a string`);
    }

    return value.trim() || null;
  }

  private handleUniqueName(error: unknown) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002'
    ) {
      throw new ConflictException(
        'A price group with that name already exists for this store',
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
