import {
  PromotionConflictStrategy,
  PromotionStatus,
  PromotionType,
} from '@prisma/client';

export type PromotionConfiguration = Record<string, boolean | number>;

export type PromotionInput = {
  name?: unknown;
  description?: unknown;
  type?: unknown;
  status?: unknown;
  startAt?: unknown;
  endAt?: unknown;
  priority?: unknown;
  stackable?: unknown;
  conflictStrategy?: unknown;
  configuration?: unknown;
  internalNotes?: unknown;
  qualifyingProductIds?: unknown;
  rewardProductIds?: unknown;
  useSeparateRewardProducts?: unknown;
  allowCashierOverride?: unknown;
  requireManagerApproval?: unknown;
  applyAutomatically?: unknown;
  printOnReceipt?: unknown;
  displayAtPos?: unknown;
  stopLowerPriority?: unknown;
  excludePriceOverrides?: unknown;
  allowRepeatedApplications?: unknown;
  maxApplicationsPerTransaction?: unknown;
  maxDiscountedQuantityPerTransaction?: unknown;
  limitOneUsePerCustomer?: unknown;
  loyaltyRequired?: unknown;
  allowEbtProducts?: unknown;
  applyBeforeTax?: unknown;
};

export type CartLineInput = {
  productId: string;
  quantity: number;
  unitPrice: number;
  priceOverride?: boolean;
};
export type EvaluationInput = {
  cartLines?: unknown;
  customerId?: unknown;
  at?: unknown;
  registerId?: unknown;
};

export const TYPE_VALUES = Object.values(PromotionType);
export const STATUS_VALUES = Object.values(PromotionStatus);
export const STRATEGY_VALUES = Object.values(PromotionConflictStrategy);
