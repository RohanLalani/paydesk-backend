import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  LoyaltyRedemptionMode,
  PunchCardRewardType,
  StorePermissionKey,
} from '@prisma/client';
import { AuthTokenPayload } from '../auth/strategies/jwt.strategy';
import { PosAccessService } from '../common/pos-access.service';
import { PrismaService } from '../prisma.service';
import {
  LOYALTY_REDEMPTION_MODE_VALUES,
  LoyaltyPointsProgramInput,
  PUNCH_CARD_REWARD_TYPE_VALUES,
  PunchCardProgramInput,
} from './loyalty.types';

const PRODUCT_SELECT = {
  id: true,
  productNumber: true,
  barcode: true,
  name: true,
  unitRetail: true,
  isActive: true,
  department: { select: { id: true, name: true } },
  productCategory: { select: { id: true, name: true } },
  priceGroup: { select: { id: true, name: true } },
} as const;

const POINTS_INCLUDE = {
  eligibleProducts: { include: { product: { select: PRODUCT_SELECT } } },
} as const;

const PUNCH_CARD_INCLUDE = {
  freeProduct: { select: PRODUCT_SELECT },
  eligibleDepartments: {
    include: {
      department: {
        select: {
          id: true,
          storeId: true,
          name: true,
          posDepartmentNumber: true,
          type: true,
          minimumAge: true,
          defaultTaxId: true,
          defaultRetailMargin: true,
          minimumRingUpAmount: true,
          maximumRingUpAmount: true,
          trackInventory: true,
          allowNegativeInventorySales: true,
          allowEbt: true,
          defaultAllowEbt: true,
          allowManualRingUp: true,
          onPos: true,
          isActive: true,
          createdAt: true,
          updatedAt: true,
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

type ParsedPunchCardProgram = {
  data: {
    name: string;
    rewardType: PunchCardRewardType;
    discountPercentage: number | null;
    freeProductId: string | null;
    requiredTransactions: number;
    minimumTransactionCents: number;
    storeWide: boolean;
    isActive: boolean;
  };
  eligibleDepartmentIds: string[];
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
    return this.findPointsProgram(storeId, programId);
  }

  async createPointsProgram(
    storeId: string,
    input: LoyaltyPointsProgramInput,
    user: AuthTokenPayload,
  ) {
    await this.ensureManage(storeId, user);
    const parsed = await this.parsePointsProgram(storeId, input);

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
        include: POINTS_INCLUDE,
      });

      return this.presentPointsProgram(program);
    });
  }

  async updatePointsProgram(
    storeId: string,
    programId: string,
    input: LoyaltyPointsProgramInput,
    user: AuthTokenPayload,
  ) {
    await this.ensureManage(storeId, user);
    await this.findPointsProgram(storeId, programId);
    const parsed = await this.parsePointsProgram(storeId, input);

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
        include: POINTS_INCLUDE,
      });

      return this.presentPointsProgram(program);
    });
  }

  async listPunchCardPrograms(storeId: string, user: AuthTokenPayload) {
    await this.ensureView(storeId, user);
    const items = await this.prisma.punchCardProgram.findMany({
      where: { storeId },
      include: {
        freeProduct: { select: { name: true } },
        _count: { select: { eligibleDepartments: true } },
      },
      orderBy: { updatedAt: 'desc' },
    });

    return {
      items: items.map((item) => {
        const { _count, freeProduct, discountPercentage, ...program } = item;
        return {
          ...program,
          discountPercentage:
            discountPercentage === null ? null : Number(discountPercentage),
          freeProductName: freeProduct?.name ?? null,
          eligibleDepartmentCount: _count.eligibleDepartments,
        };
      }),
      total: items.length,
    };
  }

  async getPunchCardProgram(
    storeId: string,
    programId: string,
    user: AuthTokenPayload,
  ) {
    await this.ensureView(storeId, user);
    return this.findPunchCardProgram(storeId, programId);
  }

  async createPunchCardProgram(
    storeId: string,
    input: PunchCardProgramInput,
    user: AuthTokenPayload,
  ) {
    await this.ensureManage(storeId, user);
    const parsed = await this.parsePunchCardProgram(storeId, input);

    return this.prisma.$transaction(async (tx) => {
      const program = await tx.punchCardProgram.create({
        data: {
          ...parsed.data,
          storeId,
          eligibleDepartments: {
            create: parsed.eligibleDepartmentIds.map((departmentId) => ({
              departmentId,
            })),
          },
        },
        include: PUNCH_CARD_INCLUDE,
      });

      return this.presentPunchCardProgram(program);
    });
  }

  async updatePunchCardProgram(
    storeId: string,
    programId: string,
    input: PunchCardProgramInput,
    user: AuthTokenPayload,
  ) {
    await this.ensureManage(storeId, user);
    await this.findPunchCardProgram(storeId, programId);
    const parsed = await this.parsePunchCardProgram(storeId, input);

    return this.prisma.$transaction(async (tx) => {
      await tx.punchCardProgramDepartment.deleteMany({ where: { programId } });
      const program = await tx.punchCardProgram.update({
        where: { id: programId },
        data: {
          ...parsed.data,
          eligibleDepartments: {
            create: parsed.eligibleDepartmentIds.map((departmentId) => ({
              departmentId,
            })),
          },
        },
        include: PUNCH_CARD_INCLUDE,
      });

      return this.presentPunchCardProgram(program);
    });
  }

  private async parsePointsProgram(
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

  private async parsePunchCardProgram(
    storeId: string,
    input: PunchCardProgramInput,
  ): Promise<ParsedPunchCardProgram> {
    const name = this.text(input.name);
    if (!name) throw new BadRequestException('Program name is required');

    const rewardType = this.enum(
      input.rewardType,
      PUNCH_CARD_REWARD_TYPE_VALUES,
      'rewardType',
    );
    const storeWide = input.storeWide !== false;
    const eligibleDepartmentIds = storeWide
      ? []
      : this.ids(input.eligibleDepartmentIds, 'eligibleDepartmentIds');

    if (!storeWide && eligibleDepartmentIds.length === 0) {
      throw new BadRequestException('At least one department is required');
    }

    const data: ParsedPunchCardProgram['data'] = {
      name,
      rewardType,
      discountPercentage: null,
      freeProductId: null,
      requiredTransactions: this.positiveInteger(
        input.requiredTransactions,
        'requiredTransactions',
      ),
      minimumTransactionCents: this.nonNegativeInteger(
        input.minimumTransactionCents,
        'minimumTransactionCents',
      ),
      storeWide,
      isActive: input.isActive !== false,
    };

    if (rewardType === PunchCardRewardType.PERCENTAGE_DISCOUNT) {
      data.discountPercentage = this.percentage(
        input.discountPercentage,
        'discountPercentage',
      );
    } else {
      data.freeProductId = this.requiredText(
        input.freeProductId,
        'freeProductId',
      );
      await this.ensureProductsInStore(storeId, [data.freeProductId]);
    }

    await this.ensureDepartmentsInStore(storeId, eligibleDepartmentIds);

    return { data, eligibleDepartmentIds };
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

  private async ensureDepartmentsInStore(
    storeId: string,
    departmentIds: string[],
  ) {
    if (departmentIds.length === 0) return;

    const count = await this.prisma.department.count({
      where: { storeId, id: { in: departmentIds } },
    });

    if (count !== departmentIds.length) {
      throw new BadRequestException(
        'Every selected department must belong to this store',
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

  private findPointsProgram(storeId: string, programId: string) {
    return this.prisma.loyaltyPointsProgram
      .findFirst({ where: { id: programId, storeId }, include: POINTS_INCLUDE })
      .then((program) => {
        if (!program) throw new NotFoundException('Points program not found');
        return this.presentPointsProgram(program);
      });
  }

  private findPunchCardProgram(storeId: string, programId: string) {
    return this.prisma.punchCardProgram
      .findFirst({
        where: { id: programId, storeId },
        include: PUNCH_CARD_INCLUDE,
      })
      .then((program) => {
        if (!program)
          throw new NotFoundException('Punch card program not found');
        return this.presentPunchCardProgram(program);
      });
  }

  private presentPointsProgram<
    T extends { eligibleProducts: Array<{ product: unknown }> },
  >(program: T) {
    return {
      ...program,
      eligibleProducts: program.eligibleProducts.map((entry) => entry.product),
    };
  }

  private presentPunchCardProgram<
    T extends {
      discountPercentage: { toString(): string } | number | null;
      eligibleDepartments: Array<{ department: unknown }>;
    },
  >(program: T) {
    return {
      ...program,
      discountPercentage:
        program.discountPercentage === null
          ? null
          : Number(program.discountPercentage),
      eligibleDepartments: program.eligibleDepartments.map(
        (entry) => entry.department,
      ),
    };
  }

  private text(value: unknown) {
    return typeof value === 'string' && value.trim() ? value.trim() : null;
  }

  private requiredText(value: unknown, field: string) {
    const parsed = this.text(value);
    if (!parsed) throw new BadRequestException(`${field} is required`);
    return parsed;
  }

  private positiveInteger(value: unknown, field: string) {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      throw new BadRequestException(`${field} must be a positive integer`);
    }

    return parsed;
  }

  private nonNegativeInteger(value: unknown, field: string) {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 0) {
      throw new BadRequestException(`${field} must be a non-negative integer`);
    }

    return parsed;
  }

  private percentage(value: unknown, field: string) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 100) {
      throw new BadRequestException(
        `${field} must be greater than 0 and no more than 100`,
      );
    }

    return Math.round(parsed * 100) / 100;
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
