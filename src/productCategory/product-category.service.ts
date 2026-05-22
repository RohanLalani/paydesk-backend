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
export class ProductCategoryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: PosAccessService,
  ) {}

  async create(body: Record<string, unknown>, user: AuthTokenPayload) {
    const dto = this.parseCreateBody(body);
    await this.access.ensureStoreAccess(
      dto.storeId,
      user,
      'manage_product_categories',
    );

    try {
      return await this.prisma.productCategory.create({ data: dto });
    } catch (error) {
      this.handleUniqueName(error);
      throw error;
    }
  }

  async listByStore(storeId: string, user: AuthTokenPayload) {
    await this.access.ensureStoreAccess(
      storeId,
      user,
      'manage_product_categories',
    );

    return this.prisma.productCategory.findMany({
      where: { storeId },
      orderBy: { name: 'asc' },
    });
  }

  async update(
    id: string,
    body: Record<string, unknown>,
    user: AuthTokenPayload,
  ) {
    const category = await this.findOrThrow(id);
    await this.access.ensureStoreAccess(
      category.storeId,
      user,
      'manage_product_categories',
    );
    const updates = this.parseUpdateBody(body);

    try {
      return await this.prisma.productCategory.update({
        where: { id },
        data: updates,
      });
    } catch (error) {
      this.handleUniqueName(error);
      throw error;
    }
  }

  async remove(id: string, user: AuthTokenPayload) {
    const category = await this.findOrThrow(id);
    await this.access.ensureStoreAccess(
      category.storeId,
      user,
      'manage_product_categories',
    );

    try {
      return await this.prisma.productCategory.delete({ where: { id } });
    } catch (error) {
      this.handleDeleteConstraint(
        error,
        'Product category is used by products',
      );
      throw error;
    }
  }

  private async findOrThrow(id: string) {
    const category = await this.prisma.productCategory.findUnique({
      where: { id },
    });

    if (!category) {
      throw new NotFoundException('Product category not found');
    }

    return category;
  }

  private parseCreateBody(body: Record<string, unknown>) {
    return {
      storeId: this.requiredString(body.storeId, 'storeId'),
      name: this.requiredString(body.name, 'name'),
      brand: this.optionalString(body.brand, 'brand'),
      description: this.optionalString(body.description, 'description'),
    };
  }

  private parseUpdateBody(
    body: Record<string, unknown>,
  ): Prisma.ProductCategoryUpdateInput {
    const updates: Prisma.ProductCategoryUpdateInput = {};

    if (body.name !== undefined) {
      updates.name = this.requiredString(body.name, 'name');
    }

    if (body.brand !== undefined) {
      updates.brand = this.optionalString(body.brand, 'brand');
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
        'A product category with that name already exists for this store',
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
