import { LoyaltyRedemptionMode } from '@prisma/client';

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

export const LOYALTY_REDEMPTION_MODE_VALUES = Object.values(
  LoyaltyRedemptionMode,
);
