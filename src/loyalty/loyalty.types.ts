import { LoyaltyRedemptionMode, PunchCardRewardType } from '@prisma/client';

export type LoyaltyPointsProgramInput = {
  name?: unknown;
  pointsEarned?: unknown;
  spendThresholdCents?: unknown;
  pointValueCents?: unknown;
  redemptionMode?: unknown;
  cashbackStoreWide?: unknown;
  eligibleProductIds?: unknown;
  isActive?: unknown;
};

export type PunchCardProgramInput = {
  name?: unknown;
  rewardType?: unknown;
  discountPercentage?: unknown;
  freeProductId?: unknown;
  requiredTransactions?: unknown;
  minimumTransactionCents?: unknown;
  storeWide?: unknown;
  eligibleDepartmentIds?: unknown;
  isActive?: unknown;
};

export const LOYALTY_REDEMPTION_MODE_VALUES = Object.values(
  LoyaltyRedemptionMode,
);

export const PUNCH_CARD_REWARD_TYPE_VALUES = Object.values(PunchCardRewardType);
