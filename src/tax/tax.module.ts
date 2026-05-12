import { Module } from '@nestjs/common';
import { TaxService } from './tax.service';
import { TaxController } from './tax.controller';

@Module({
  providers: [TaxService],
  controllers: [TaxController]
})
export class TaxModule {}
