import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ProductService } from './product.service';

const REFRESH_INTERVAL_MS = 10 * 60 * 1000;

@Injectable()
export class PriceGroupMismatchRefreshService
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(PriceGroupMismatchRefreshService.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(private readonly productService: ProductService) {}

  onModuleInit() {
    this.timer = setInterval(() => {
      void this.refresh();
    }, REFRESH_INTERVAL_MS);
    this.timer.unref?.();
  }

  onModuleDestroy() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async refresh() {
    if (this.running) return;
    this.running = true;

    try {
      await this.productService.refreshAllPriceGroupMismatchCaches();
    } catch (error) {
      this.logger.warn(
        `Price group mismatch refresh failed: ${
          error instanceof Error ? error.message : 'unknown error'
        }`,
      );
    } finally {
      this.running = false;
    }
  }
}
