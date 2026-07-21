import { Injectable } from '@nestjs/common';
import { PromotionConflictStrategy, PromotionType } from '@prisma/client';
import { CartLineInput, PromotionConfiguration } from './promotion.types';

export type EvaluatablePromotion = {
  id: string;
  name: string;
  type: PromotionType;
  priority: number;
  stackable: boolean;
  conflictStrategy: PromotionConflictStrategy;
  configuration: PromotionConfiguration;
  maxApplicationsPerTransaction: number | null;
  excludePriceOverrides: boolean;
  qualifyingProductIds: string[];
  rewardProductIds: string[];
};

type Candidate = {
  promotion: EvaluatablePromotion;
  lineDiscounts: Record<string, number>;
  totalDiscount: number;
  explanation: string;
};

@Injectable()
export class PromotionEvaluationService {
  evaluate(lines: CartLineInput[], promotions: EvaluatablePromotion[]) {
    const candidates = promotions
      .map((promotion) => this.calculate(lines, promotion))
      .filter((item): item is Candidate =>
        Boolean(item && item.totalDiscount > 0),
      );
    const applied: Candidate[] = [];
    for (const candidate of [...candidates].sort(
      (a, b) => b.promotion.priority - a.promotion.priority,
    )) {
      const conflicts = applied.filter(
        (item) => !item.promotion.stackable || !candidate.promotion.stackable,
      );
      if (!conflicts.length) {
        applied.push(candidate);
        continue;
      }
      const incumbent = conflicts[0];
      const strategy = candidate.promotion.conflictStrategy;
      const shouldReplace =
        strategy === PromotionConflictStrategy.BEST_CUSTOMER_DISCOUNT
          ? candidate.totalDiscount > incumbent.totalDiscount
          : strategy === PromotionConflictStrategy.BEST_STORE_MARGIN
            ? candidate.totalDiscount < incumbent.totalDiscount
            : candidate.promotion.priority > incumbent.promotion.priority;
      if (shouldReplace)
        applied.splice(applied.indexOf(incumbent), 1, candidate);
    }
    const discounts: Record<string, number> = {};
    for (const result of applied)
      for (const [productId, amount] of Object.entries(result.lineDiscounts))
        discounts[productId] = (discounts[productId] ?? 0) + amount;
    const finalLines = lines.map((line) => {
      const originalTotal = this.money(line.quantity * line.unitPrice);
      const discount = Math.min(
        originalTotal,
        this.money(discounts[line.productId] ?? 0),
      );
      return {
        ...line,
        originalTotal,
        discount,
        finalTotal: this.money(Math.max(0, originalTotal - discount)),
      };
    });
    return {
      eligiblePromotions: candidates.map((item) => ({
        id: item.promotion.id,
        name: item.promotion.name,
        discount: item.totalDiscount,
      })),
      appliedPromotions: applied.map((item) => ({
        id: item.promotion.id,
        name: item.promotion.name,
        discount: item.totalDiscount,
        explanation: item.explanation,
      })),
      lineTotals: finalLines,
      totalDiscount: this.money(
        finalLines.reduce((sum, line) => sum + line.discount, 0),
      ),
      finalTotal: this.money(
        finalLines.reduce((sum, line) => sum + line.finalTotal, 0),
      ),
      conflicts: candidates
        .filter((item) => !applied.includes(item))
        .map((item) => ({
          promotionId: item.promotion.id,
          reason: 'A competing promotion won the configured conflict rule.',
        })),
    };
  }

  private calculate(
    lines: CartLineInput[],
    promotion: EvaluatablePromotion,
  ): Candidate | null {
    const qualifying = lines.filter(
      (line) =>
        promotion.qualifyingProductIds.includes(line.productId) &&
        !(promotion.excludePriceOverrides && line.priceOverride),
    );
    const rewards = promotion.rewardProductIds.length
      ? lines.filter((line) =>
          promotion.rewardProductIds.includes(line.productId),
        )
      : qualifying;
    const config = promotion.configuration;
    const discounts: Record<string, number> = {};
    let applications = 0;
    const limit =
      promotion.maxApplicationsPerTransaction ?? Number.MAX_SAFE_INTEGER;
    const add = (line: CartLineInput, amount: number) => {
      discounts[line.productId] =
        (discounts[line.productId] ?? 0) +
        Math.max(0, Math.min(line.quantity * line.unitPrice, amount));
    };
    const qty = qualifying.reduce((sum, line) => sum + line.quantity, 0);
    const spend = qualifying.reduce(
      (sum, line) => sum + line.quantity * line.unitPrice,
      0,
    );
    switch (promotion.type) {
      case PromotionType.BUY_X_GET_Y_FREE:
      case PromotionType.BUY_X_GET_Y_PERCENT_OFF: {
        const buy = Number(config.buyQuantity);
        const rewardQty = Number(
          config.rewardQuantity ?? config.discountedQuantity,
        );
        if (qty < buy || !rewards.length) return null;
        const applicationQuantity = promotion.rewardProductIds.length
          ? buy
          : buy + rewardQty;
        applications = Math.min(
          limit,
          config.allowMultiples === false
            ? 1
            : Math.floor(qty / applicationQuantity),
        );
        if (!applications) return null;
        let units = applications * rewardQty;
        const rate =
          promotion.type === PromotionType.BUY_X_GET_Y_FREE
            ? 1
            : Number(config.discountPercentage) / 100;
        for (const line of [...rewards].sort(
          (a, b) => a.unitPrice - b.unitPrice,
        )) {
          const used = Math.min(units, line.quantity);
          add(line, used * line.unitPrice * rate);
          units -= used;
          if (!units) break;
        }
        break;
      }
      case PromotionType.QUANTITY_BUNDLE_PRICE: {
        const required = Number(config.requiredQuantity);
        applications = Math.min(
          limit,
          config.allowMultiples === false ? 1 : Math.floor(qty / required),
        );
        if (!applications) return null;
        const unitValue =
          qualifying.reduce(
            (sum, line) => sum + line.unitPrice * line.quantity,
            0,
          ) / qty;
        const discount = Math.max(
          0,
          applications * (required * unitValue - Number(config.bundlePrice)),
        );
        add(qualifying[0], discount);
        break;
      }
      case PromotionType.PERCENT_OFF_ITEM:
        for (const line of qualifying)
          add(
            line,
            (line.quantity *
              line.unitPrice *
              Number(config.discountPercentage)) /
              100,
          );
        break;
      case PromotionType.FIXED_AMOUNT_OFF_ITEM:
        for (const line of qualifying)
          add(line, line.quantity * Number(config.discountAmount));
        break;
      case PromotionType.SPEND_THRESHOLD_FIXED_OFF:
        if (spend < Number(config.minimumSpend)) return null;
        add(qualifying[0], Number(config.discountAmount));
        break;
      case PromotionType.SPEND_THRESHOLD_PERCENT_OFF:
        if (spend < Number(config.minimumSpend)) return null;
        add(
          qualifying[0],
          Math.min(
            (spend * Number(config.discountPercentage)) / 100,
            Number(config.maximumDiscountAmount ?? Number.MAX_SAFE_INTEGER),
          ),
        );
        break;
      case PromotionType.CUSTOM_PRICE:
        for (const line of qualifying)
          add(
            line,
            line.quantity *
              Math.max(0, line.unitPrice - Number(config.promotionalUnitPrice)),
          );
        break;
      default:
        return null;
    }
    const total = this.money(
      Object.values(discounts).reduce((sum, value) => sum + value, 0),
    );
    return total
      ? {
          promotion,
          lineDiscounts: discounts,
          totalDiscount: total,
          explanation: `${promotion.name} applied for a ${total.toFixed(2)} discount.`,
        }
      : null;
  }
  private money(value: number) {
    return Math.round((value + Number.EPSILON) * 100) / 100;
  }
}
