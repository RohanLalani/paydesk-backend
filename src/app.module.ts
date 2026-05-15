import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { AppController } from './app.controller';
import { AppService } from './app.service';

import { PrismaModule } from './prisma/prisma.module';

// Core
import { AuthModule } from './auth/auth.module';
import { StoreModule } from './store/store.module';
import { ShiftModule } from './shift/shift.module';
import { ProductModule } from './product/product.module';
import { InventoryModule } from './inventory/inventory.module';
import { CartModule } from './cart/cart.module';
import { TransactionModule } from './transaction/transaction.module';
import { ReceiptModule } from './receipt/receipt.module';
import { ReportModule } from './report/report.module';
import { RefundModule } from './refund/refund.module';
import { TaxModule } from './tax/tax.module';

// Inventory / Operations
import { SupplierModule } from './supplier/supplier.module';
import { PurchaseOrderModule } from './purchase-order/purchase-order.module';
import { StockTransferModule } from './stock-transfer/stock-transfer.module';

// Employees
import { EmployeeModule } from './employee/employee.module';
import { PayrollModule } from './payroll/payroll.module';
import { AttendanceModule } from './attendance/attendance.module';

// Customer Systems
import { CustomerModule } from './customer/customer.module';
import { LoyaltyModule } from './loyalty/loyalty.module';
import { GiftCardModule } from './gift-card/gift-card.module';
import { MembershipModule } from './membership/membership.module';

// Payments
import { PaymentModule } from './payment/payment.module';
import { CouponModule } from './coupon/coupon.module';
import { PromotionModule } from './promotion/promotion.module';

// Analytics
import { DashboardModule } from './dashboard/dashboard.module';
import { AnalyticsModule } from './analytics/analytics.module';
import { AuditModule } from './audit/audit.module';

// Settings / Notifications
import { SettingsModule } from './settings/settings.module';
import { NotificationModule } from './notification/notification.module';
import { EmailModule } from './email/email.module';
import { SmsModule } from './sms/sms.module';

// Hardware
import { PrinterModule } from './printer/printer.module';
import { ScannerModule } from './scanner/scanner.module';
import { TerminalModule } from './terminal/terminal.module';
import { DeviceModule } from './device/device.module';

// Online Ordering
import { OnlineOrderModule } from './online-order/online-order.module';
import { DeliveryModule } from './delivery/delivery.module';
import { DriverModule } from './driver/driver.module';

// Other
import { CatalogModule } from './catalog/catalog.module';
import { InvoiceModule } from './invoice/invoice.module';
import { CashManagementModule } from './cash-management/cash-management.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
    }),

    PrismaModule,

    // Core
    AuthModule,
    StoreModule,
    ShiftModule,
    ProductModule,
    InventoryModule,
    CartModule,
    TransactionModule,
    ReceiptModule,
    ReportModule,
    RefundModule,
    TaxModule,

    // Inventory / Operations
    SupplierModule,
    PurchaseOrderModule,
    StockTransferModule,

    // Employees
    EmployeeModule,
    PayrollModule,
    AttendanceModule,

    // Customer Systems
    CustomerModule,
    LoyaltyModule,
    GiftCardModule,
    MembershipModule,

    // Payments
    PaymentModule,
    CouponModule,
    PromotionModule,

    // Analytics
    DashboardModule,
    AnalyticsModule,
    AuditModule,

    // Settings / Notifications
    SettingsModule,
    NotificationModule,
    EmailModule,
    SmsModule,

    // Hardware
    PrinterModule,
    ScannerModule,
    TerminalModule,
    DeviceModule,

    // Online Ordering
    OnlineOrderModule,
    DeliveryModule,
    DriverModule,

    // Other
    CatalogModule,
    InvoiceModule,
    CashManagementModule,
  ],

  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}