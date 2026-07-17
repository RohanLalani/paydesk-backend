import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

type TaxConfig = {
  rate?: number | Prisma.Decimal | null;
  surchargeAmount?: number | string | Prisma.Decimal | null;
};

@Injectable()
export class TaxCalculationService {
  calculateLineTax(taxableAmount: Prisma.Decimal, tax?: TaxConfig | null) {
    const rate = new Prisma.Decimal(tax?.rate ?? 0);
    const surchargeAmount = new Prisma.Decimal(tax?.surchargeAmount ?? 0);

    // Fixed surcharges are applied once per taxable transaction line.
    return this.roundMoney(taxableAmount.mul(rate).plus(surchargeAmount));
  }

  private roundMoney(value: Prisma.Decimal) {
    return value.toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
  }
}
