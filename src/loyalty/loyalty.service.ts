import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { LoyaltyRedemptionMode, StorePermissionKey } from '@prisma/client';
import { AuthTokenPayload } from '../auth/strategies/jwt.strategy';
import { PosAccessService } from '../common/pos-access.service';
import { PrismaService } from '../prisma.service';
import {
  LOYALTY_REDEMPTION_MODE_VALUES,
  LoyaltyPointsProgramInput,
} from './loyalty.types';

const INCLUDE = {
  eligibleProducts: {
    include: {
      product: {
        select: {
          id: true,
          productNumber: true,
          barcode: true,
          name: true,
          unitRetail: true,
          isActive: true,
          department: { select: { id: true, name: true } },
          productCategory: { select: { id: true, name: true } },
          priceGroup: { select: { id: true, name: true } },
        },
      },
    },
  },
} as const;

type ParsedPointsProgram = {
  data: {
    name: string;
    pointsEarned: number;
    spendThresholdCents: number;
    pointValueCents: number;
    redemptionMode: LoyaltyRedemptionMode;
    cashbackStoreWide: boolean;
    isActive: boolean;
  };
  eligibleProductIds: string[];
};

@Injectable()
export class LoyaltyService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: PosAccessService,
  ) {}

  async listPointsPrograms(storeId: string, user: AuthTokenPayload) {
    await this.ensureView(storeId, user);
    const items = await this.prisma.loyaltyPointsProgram.findMany({
      where: { storeId },
      include: { _count: { select: { eligibleProducts: true } } },
      orderBy: { updatedAt: 'desc' },
    });

    return {
      items: items.map((item) => {
        const { _count, ...program } = item;
        return {
          ...program,
          eligibleProductCount: _count.eligibleProducts,
        };
      }),
      total: items.length,
    };
  }

  async getPointsProgram(
    storeId: string,
    programId: string,
    user: AuthTokenPayload,
  ) {
    await this.ensureView(storeId, user);
    return this.find(storeId, programId);
  }

  async createPointsProgram(
    storeId: string,
    input: LoyaltyPointsProgramInput,
    user: AuthTokenPayload,
  ) {
    await this.ensureManage(storeId, user);
    const parsed = await this.parse(storeId, input);

    return this.prisma.$transaction(async (tx) => {
      const program = await tx.loyaltyPointsProgram.create({
        data: {
          ...parsed.data,
          storeId,
          eligibleProducts: {
            create: parsed.eligibleProductIds.map((productId) => ({
              productId,
            })),
          },
        },
        include: INCLUDE,
      });

      return this.present(program);
    });
  }

  async updatePointsProgram(
    storeId: string,
    programId: string,
    input: LoyaltyPointsProgramInput,
    user: AuthTokenPayload,
  ) {
    await this.ensureManage(storeId, user);
    await this.find(storeId, programId);
    const parsed = await this.parse(storeId, input);

    return this.prisma.$transaction(async (tx) => {
      await tx.loyaltyPointsProgramProduct.deleteMany({ where: { programId } });
      const program = await tx.loyaltyPointsProgram.update({
        where: { id: programId },
        data: {
          ...parsed.data,
          eligibleProducts: {
            create: parsed.eligibleProductIds.map((productId) => ({
              productId,
            })),
          },
        },
        include: INCLUDE,
      });

      return this.present(program);
    });
  }

  private async parse(
    storeId: string,
    input: LoyaltyPointsProgramInput,
  ): Promise<ParsedPointsProgram> {
    const name = this.text(input.name);
    if (!name) throw new BadRequestException('Program name is required');

    const redemptionMode = this.enum(
      input.redemptionMode,
      LOYALTY_REDEMPTION_MODE_VALUES,
      'redemptionMode',
    );
    const cashbackStoreWide =
      redemptionMode === LoyaltyRedemptionMode.CASHBACK
        ? input.cashbackStoreWide !== false
        : false;
    const eligibleProductIds = this.ids(
      input.eligibleProductIds,
      'eligibleProductIds',
    );

    if (
      this.requiresEligibleItems(redemptionMode, cashbackStoreWide) &&
      eligibleProductIds.length === 0
    ) {
      throw new BadRequestException(
        'At least one eligible product is required',
      );
    }

    await this.ensureProductsInStore(storeId, eligibleProductIds);

    return {
      data: {
        name,
        pointsEarned: this.positiveInteger(input.pointsEarned, 'pointsEarned'),
        spendThresholdCents: this.positiveInteger(
          input.spendThresholdCents,
          'spendThresholdCents',
        ),
        pointValueCents: this.positiveInteger(
          input.pointValueCents,
          'pointValueCents',
        ),
        redemptionMode,
        cashbackStoreWide,
        isActive: input.isActive !== false,
      },
      eligibleProductIds,
    };
  }

  private async ensureProductsInStore(storeId: string, productIds: string[]) {
    if (productIds.length === 0) return;

    const count = await this.prisma.product.count({
      where: { storeId, id: { in: productIds } },
    });

    if (count !== productIds.length) {
      throw new BadRequestException(
        'Every selected product must belong to this store',
      );
    }
  }

  private requiresEligibleItems(
    redemptionMode: LoyaltyRedemptionMode,
    cashbackStoreWide: boolean,
  ) {
    return (
      redemptionMode === LoyaltyRedemptionMode.PRODUCTS ||
      redemptionMode === LoyaltyRedemptionMode.BOTH ||
      (redemptionMode === LoyaltyRedemptionMode.CASHBACK && !cashbackStoreWide)
    );
  }

  private async ensureView(storeId: string, user: AuthTokenPayload) {
    try {
      await this.access.ensureStoreAccess(
        storeId,
        user,
        StorePermissionKey.manage_customers,
      );
    } catch {
      await this.access.ensureStoreAccess(
        storeId,
        user,
        StorePermissionKey.view_store,
      );
    }
  }

  private ensureManage(storeId: string, user: AuthTokenPayload) {
    return this.access.ensureStoreAccess(
      storeId,
      user,
      StorePermissionKey.manage_customers,
    );
  }

  private find(storeId: string, programId: string) {
    return this.prisma.loyaltyPointsProgram
      .findFirst({ where: { id: programId, storeId }, include: INCLUDE })
      .then((program) => {
        if (!program) throw new NotFoundException('Points program not found');
        return this.present(program);
      });
  }

  private present<T extends { eligibleProducts: Array<{ product: unknown }> }>(
    program: T,
  ) {
    return {
      ...program,
      eligibleProducts: program.eligibleProducts.map((entry) => entry.product),
    };
  }

  private text(value: unknown) {
    return typeof value === 'string' && value.trim() ? value.trim() : null;
  }

  private positiveInteger(value: unknown, field: string) {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      throw new BadRequestException(`${field} must be a positive integer`);
    }

    return parsed;
  }

  private enum<T>(value: unknown, values: T[], field: string): T {
    if (!values.includes(value as T)) {
      throw new BadRequestException(`${field} is invalid`);
    }

    return value as T;
  }

  private ids(value: unknown, field: string) {
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value))
      throw new BadRequestException(`${field} must be an array`);

    const ids = value.map((id) => this.text(id));
    if (ids.some((id) => !id))
      throw new BadRequestException(`${field} must contain IDs`);

    const uniqueIds = new Set(ids as string[]);
    if (uniqueIds.size !== ids.length)
      throw new BadRequestException(`${field} must not contain duplicates`);

    return [...uniqueIds];
  }
}
