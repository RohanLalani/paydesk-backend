import { PromotionConflictStrategy, PromotionType } from '@prisma/client';
import {
  PromotionEvaluationService,
  type EvaluatablePromotion,
} from './promotion-evaluation.service';

describe('PromotionEvaluationService', () => {
  const service = new PromotionEvaluationService();
  const base = (
    type: PromotionType,
    configuration: Record<string, number | boolean>,
    patch: Partial<EvaluatablePromotion> = {},
  ): EvaluatablePromotion => ({
    id: type,
    name: type,
    type,
    priority: 1,
    stackable: false,
    conflictStrategy: PromotionConflictStrategy.PRIORITY,
    configuration,
    maxApplicationsPerTransaction: null,
    excludePriceOverrides: true,
    qualifyingProductIds: ['a'],
    rewardProductIds: [],
    ...patch,
  });
  const lines = [{ productId: 'a', quantity: 2, unitPrice: 10 }];

  it.each([
    [PromotionType.BUY_X_GET_Y_FREE, { buyQuantity: 1, rewardQuantity: 1 }, 10],
    [
      PromotionType.BUY_X_GET_Y_PERCENT_OFF,
      { buyQuantity: 1, discountedQuantity: 1, discountPercentage: 50 },
      5,
    ],
    [
      PromotionType.QUANTITY_BUNDLE_PRICE,
      { requiredQuantity: 2, bundlePrice: 15 },
      5,
    ],
    [
      PromotionType.PERCENT_OFF_ITEM,
      { discountPercentage: 20, minimumQuantity: 1 },
      4,
    ],
    [
      PromotionType.FIXED_AMOUNT_OFF_ITEM,
      { discountAmount: 2, minimumQuantity: 1 },
      4,
    ],
    [
      PromotionType.SPEND_THRESHOLD_FIXED_OFF,
      { minimumSpend: 15, discountAmount: 3 },
      3,
    ],
    [
      PromotionType.SPEND_THRESHOLD_PERCENT_OFF,
      { minimumSpend: 15, discountPercentage: 10 },
      2,
    ],
    [PromotionType.CUSTOM_PRICE, { promotionalUnitPrice: 8 }, 4],
  ])('calculates %s', (type, configuration, expected) => {
    expect(
      service.evaluate(lines, [base(type, configuration)]).totalDiscount,
    ).toBe(expected);
  });

  it('uses customer discount strategy for competing non-stackable promotions', () => {
    const result = service.evaluate(lines, [
      base(PromotionType.FIXED_AMOUNT_OFF_ITEM, {
        discountAmount: 1,
        minimumQuantity: 1,
      }),
      base(
        PromotionType.PERCENT_OFF_ITEM,
        { discountPercentage: 30, minimumQuantity: 1 },
        { conflictStrategy: PromotionConflictStrategy.BEST_CUSTOMER_DISCOUNT },
      ),
    ]);
    expect(result.totalDiscount).toBe(6);
  });

  it('combines promotions only when both are stackable', () => {
    const promotions = [
      base(
        PromotionType.FIXED_AMOUNT_OFF_ITEM,
        { discountAmount: 1, minimumQuantity: 1 },
        { stackable: true },
      ),
      base(
        PromotionType.PERCENT_OFF_ITEM,
        { discountPercentage: 10, minimumQuantity: 1 },
        { stackable: true },
      ),
    ];
    expect(service.evaluate(lines, promotions).totalDiscount).toBe(4);
  });

  it('never discounts below zero and respects application limits', () => {
    const promotion = base(
      PromotionType.BUY_X_GET_Y_FREE,
      { buyQuantity: 1, rewardQuantity: 1 },
      { maxApplicationsPerTransaction: 1 },
    );
    expect(service.evaluate(lines, [promotion]).totalDiscount).toBe(10);
  });
});
