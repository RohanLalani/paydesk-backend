import { ForbiddenException, Injectable } from '@nestjs/common';
import {
  PaymentMethod,
  PaymentStatus,
  Prisma,
  StorePermissionKey,
  TransactionStatus,
} from '@prisma/client';
import { AuthTokenPayload } from '../auth/strategies/jwt.strategy';
import { PosAccessService } from '../common/pos-access.service';
import { PrismaService } from '../prisma.service';

export type DashboardRange = 'today' | 'week' | 'month';

type TimeBucket = {
  label: string;
  start: Date;
  end: Date;
};

@Injectable()
export class DashboardService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: PosAccessService,
  ) {}

  async getStoreSummary(
    storeId: string,
    user: AuthTokenPayload,
    requestedRange: DashboardRange = 'today',
  ) {
    const range = this.normalizeRange(requestedRange);
    await this.ensureDashboardAccess(storeId, user);

    const { current, previous, buckets } = this.getRangeWindows(range);
    const transactionWhere = this.getPaidCompletedWhere(storeId, current);
    const previousTransactionWhere = this.getPaidCompletedWhere(
      storeId,
      previous,
    );

    const [
      salesAggregate,
      transactionCount,
      previousSalesAggregate,
      previousTransactionCount,
      lowStockItems,
      customers,
      trendTransactions,
      recentTransactions,
      inventoryAlerts,
      transactionItems,
    ] = await Promise.all([
      this.prisma.transaction.aggregate({
        where: transactionWhere,
        _sum: { total: true },
      }),
      this.prisma.transaction.count({ where: transactionWhere }),
      this.prisma.transaction.aggregate({
        where: previousTransactionWhere,
        _sum: { total: true },
      }),
      this.prisma.transaction.count({ where: previousTransactionWhere }),
      this.prisma.product.count({
        where: {
          storeId,
          isActive: true,
          trackInventory: true,
          minInventory: { not: null },
          currentQuantity: { lte: this.prisma.product.fields.minInventory },
        },
      }),
      this.prisma.customerStore.count({ where: { storeId } }),
      this.prisma.transaction.findMany({
        where: transactionWhere,
        select: {
          total: true,
          createdAt: true,
        },
      }),
      this.prisma.transaction.findMany({
        where: transactionWhere,
        orderBy: { createdAt: 'desc' },
        take: 5,
        select: {
          id: true,
          paymentMethod: true,
          total: true,
          createdAt: true,
        },
      }),
      this.prisma.product.findMany({
        where: {
          storeId,
          isActive: true,
          trackInventory: true,
          minInventory: { not: null },
          currentQuantity: { lte: this.prisma.product.fields.minInventory },
        },
        orderBy: [{ currentQuantity: 'asc' }, { name: 'asc' }],
        take: 5,
        select: {
          id: true,
          name: true,
          currentQuantity: true,
          minInventory: true,
        },
      }),
      this.prisma.transactionItem.findMany({
        where: {
          transaction: transactionWhere,
        },
        select: {
          productId: true,
          nameSnapshot: true,
          quantity: true,
          lineTotal: true,
        },
      }),
    ]);

    const todaysSales = this.toNumber(salesAggregate._sum.total);
    const previousSales = this.toNumber(previousSalesAggregate._sum.total);
    const avgOrderValue = transactionCount ? todaysSales / transactionCount : 0;
    const previousAvgOrderValue = previousTransactionCount
      ? previousSales / previousTransactionCount
      : 0;

    return {
      storeId,
      range,
      metrics: {
        todaysSales,
        transactions: transactionCount,
        avgOrderValue,
        lowStockItems,
        customers,
        employeesActive: 0,
      },
      changes: {
        salesChangePercent: this.percentChange(todaysSales, previousSales),
        transactionChangeText: this.transactionChangeText(
          transactionCount,
          range,
        ),
        avgOrderChangePercent: this.percentChange(
          avgOrderValue,
          previousAvgOrderValue,
        ),
        customersChangeText: '+0 this week',
        employeesActiveText: '0 logged in',
      },
      salesTrend: this.buildSalesTrend(buckets, trendTransactions),
      recentActivity: recentTransactions.map((transaction) => ({
        id: transaction.id,
        type: transaction.paymentMethod,
        title: this.paymentTitle(transaction.paymentMethod),
        subtitle: this.relativeTime(transaction.createdAt),
        amount: this.toNumber(transaction.total),
        createdAt: transaction.createdAt.toISOString(),
      })),
      inventoryAlerts: inventoryAlerts.map((product) => ({
        id: product.id,
        name: product.name,
        currentQuantity: product.currentQuantity,
        minInventory: product.minInventory ?? 0,
      })),
      topProducts: this.buildTopProducts(transactionItems),
    };
  }

  private async ensureDashboardAccess(storeId: string, user: AuthTokenPayload) {
    try {
      await this.access.ensureStoreAccess(
        storeId,
        user,
        StorePermissionKey.view_reports,
      );
    } catch (error) {
      if (!(error instanceof ForbiddenException)) {
        throw error;
      }

      await this.access.ensureStoreAccess(
        storeId,
        user,
        StorePermissionKey.view_store,
      );
    }
  }

  private normalizeRange(range: DashboardRange | undefined): DashboardRange {
    return range === 'week' || range === 'month' ? range : 'today';
  }

  private getRangeWindows(range: DashboardRange) {
    const now = new Date();
    const currentStart = new Date(now);
    const currentEnd = new Date(now);
    const previousStart = new Date(now);
    const previousEnd = new Date(now);

    if (range === 'today') {
      currentStart.setHours(0, 0, 0, 0);
      currentEnd.setHours(23, 59, 59, 999);
      previousStart.setDate(currentStart.getDate() - 1);
      previousStart.setHours(0, 0, 0, 0);
      previousEnd.setDate(currentStart.getDate() - 1);
      previousEnd.setHours(23, 59, 59, 999);

      return {
        current: { start: currentStart, end: currentEnd },
        previous: { start: previousStart, end: previousEnd },
        buckets: this.hourBuckets(currentStart, currentEnd),
      };
    }

    if (range === 'week') {
      const day = currentStart.getDay();
      currentStart.setDate(currentStart.getDate() - day);
      currentStart.setHours(0, 0, 0, 0);
      currentEnd.setTime(currentStart.getTime());
      currentEnd.setDate(currentEnd.getDate() + 7);
      currentEnd.setMilliseconds(-1);
      previousStart.setTime(currentStart.getTime());
      previousStart.setDate(previousStart.getDate() - 7);
      previousEnd.setTime(currentStart.getTime());
      previousEnd.setMilliseconds(-1);

      return {
        current: { start: currentStart, end: currentEnd },
        previous: { start: previousStart, end: previousEnd },
        buckets: this.dayBuckets(currentStart, 7),
      };
    }

    currentStart.setDate(1);
    currentStart.setHours(0, 0, 0, 0);
    currentEnd.setMonth(currentStart.getMonth() + 1, 1);
    currentEnd.setHours(0, 0, 0, 0);
    currentEnd.setMilliseconds(-1);
    previousStart.setTime(currentStart.getTime());
    previousStart.setMonth(previousStart.getMonth() - 1);
    previousEnd.setTime(currentStart.getTime());
    previousEnd.setMilliseconds(-1);

    return {
      current: { start: currentStart, end: currentEnd },
      previous: { start: previousStart, end: previousEnd },
      buckets: this.dayBuckets(
        currentStart,
        new Date(
          currentStart.getFullYear(),
          currentStart.getMonth() + 1,
          0,
        ).getDate(),
      ),
    };
  }

  private getPaidCompletedWhere(
    storeId: string,
    window: { start: Date; end: Date },
  ): Prisma.TransactionWhereInput {
    return {
      storeId,
      transactionStatus: TransactionStatus.completed,
      paymentStatus: PaymentStatus.paid,
      createdAt: {
        gte: window.start,
        lte: window.end,
      },
    };
  }

  private hourBuckets(start: Date, end: Date): TimeBucket[] {
    const buckets: TimeBucket[] = [];

    for (let hour = 0; hour < 24; hour += 1) {
      const bucketStart = new Date(start);
      bucketStart.setHours(hour, 0, 0, 0);
      const bucketEnd = new Date(bucketStart);
      bucketEnd.setHours(hour, 59, 59, 999);

      buckets.push({
        label: hour === 23 ? 'NOW' : `${String(hour).padStart(2, '0')}:00`,
        start: bucketStart,
        end: bucketEnd > end ? end : bucketEnd,
      });
    }

    return buckets;
  }

  private dayBuckets(start: Date, count: number): TimeBucket[] {
    return Array.from({ length: count }, (_, index) => {
      const bucketStart = new Date(start);
      bucketStart.setDate(start.getDate() + index);
      bucketStart.setHours(0, 0, 0, 0);
      const bucketEnd = new Date(bucketStart);
      bucketEnd.setHours(23, 59, 59, 999);

      return {
        label: bucketStart.toLocaleDateString('en-US', {
          month: 'short',
          day: 'numeric',
        }),
        start: bucketStart,
        end: bucketEnd,
      };
    });
  }

  private buildSalesTrend(
    buckets: TimeBucket[],
    transactions: Array<{ createdAt: Date; total: Prisma.Decimal }>,
  ) {
    return buckets.map((bucket) => {
      const value = transactions
        .filter(
          (transaction) =>
            transaction.createdAt >= bucket.start &&
            transaction.createdAt <= bucket.end,
        )
        .reduce(
          (sum, transaction) => sum + this.toNumber(transaction.total),
          0,
        );

      return {
        label: bucket.label,
        value,
      };
    });
  }

  private buildTopProducts(
    items: Array<{
      productId: string;
      nameSnapshot: string;
      quantity: number;
      lineTotal: Prisma.Decimal;
    }>,
  ) {
    const products = new Map<
      string,
      { productId: string; name: string; unitsSold: number; revenue: number }
    >();

    for (const item of items) {
      const current = products.get(item.productId) ?? {
        productId: item.productId,
        name: item.nameSnapshot,
        unitsSold: 0,
        revenue: 0,
      };

      current.unitsSold += item.quantity;
      current.revenue += this.toNumber(item.lineTotal);
      products.set(item.productId, current);
    }

    return [...products.values()]
      .sort(
        (first, second) =>
          second.revenue - first.revenue || second.unitsSold - first.unitsSold,
      )
      .slice(0, 5);
  }

  private paymentTitle(method: PaymentMethod) {
    const titles = {
      [PaymentMethod.card]: 'Card Payment',
      [PaymentMethod.cash]: 'Cash Sale',
      [PaymentMethod.ebt]: 'EBT Payment',
      [PaymentMethod.split]: 'Split Payment',
      [PaymentMethod.other]: 'Payment',
    } satisfies Record<PaymentMethod, string>;

    return titles[method];
  }

  private transactionChangeText(count: number, range: DashboardRange) {
    if (range === 'today') {
      return `+${count} today`;
    }

    return `+${count} this ${range}`;
  }

  private relativeTime(date: Date) {
    const seconds = Math.max(
      0,
      Math.floor((Date.now() - date.getTime()) / 1000),
    );

    if (seconds < 60) {
      return `${seconds} seconds ago`;
    }

    const minutes = Math.floor(seconds / 60);

    if (minutes < 60) {
      return `${minutes} minutes ago`;
    }

    const hours = Math.floor(minutes / 60);

    if (hours < 24) {
      return `${hours} hours ago`;
    }

    return `${Math.floor(hours / 24)} days ago`;
  }

  private percentChange(current: number, previous: number) {
    if (!previous) {
      return 0;
    }

    return ((current - previous) / previous) * 100;
  }

  private toNumber(value: Prisma.Decimal | null | undefined) {
    return value ? value.toNumber() : 0;
  }
}
