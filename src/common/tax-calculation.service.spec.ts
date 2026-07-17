import { Prisma } from '@prisma/client';
import { TaxCalculationService } from './tax-calculation.service';

describe('TaxCalculationService', () => {
  const service = new TaxCalculationService();

  it('adds a fixed surcharge once per taxable line', () => {
    const tax = service.calculateLineTax(new Prisma.Decimal(30), {
      rate: 0.1,
      surchargeAmount: new Prisma.Decimal('0.15'),
    });

    expect(tax.toFixed(2)).toBe('3.15');
  });

  it('accepts percentage-free surcharge taxes', () => {
    const tax = service.calculateLineTax(new Prisma.Decimal(10), {
      rate: 0,
      surchargeAmount: new Prisma.Decimal('0.50'),
    });

    expect(tax.toFixed(2)).toBe('0.50');
  });
});
