import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { PosAccessService } from '../common/pos-access.service';
import { PrismaService } from '../prisma.service';
import { PromotionController } from './promotion.controller';
import { PromotionEvaluationService } from './promotion-evaluation.service';
import { PromotionService } from './promotion.service';

@Module({
  imports: [AuditModule],
  controllers: [PromotionController],
  providers: [
    PromotionService,
    PromotionEvaluationService,
    PrismaService,
    PosAccessService,
  ],
  exports: [PromotionEvaluationService],
})
export class PromotionModule {}
