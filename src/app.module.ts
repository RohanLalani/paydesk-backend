import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AuthModule } from './auth/auth.module';
import { StoreModule } from './store/store.module';
import { ShiftModule } from './shift/shift.module';
import { ProductModule } from './product/product.module';
import { CartModule } from './cart/cart.module';
import { TransactionModule } from './transaction/transaction.module';
import { ReceiptModule } from './receipt/receipt.module';
import { ReportModule } from './report/report.module';
import { InventoryModule } from './inventory/inventory.module';
import { SupplierModule } from './supplier/supplier.module';
import { PurchaseOrderModule } from './purchase-order/purchase-order.module';
import { StockTransferModule } from './stock-transfer/stock-transfer.module';
import { EmployeeModule } from './employee/employee.module';
import { PayrollModule } from './payroll/payroll.module';
import { AttendanceModule } from './attendance/attendance.module';
import { CustomerModule } from './customer/customer.module';
import { LoyaltyModule } from './loyalty/loyalty.module';
import { GiftCardModule } from './gift-card/gift-card.module';
import { PaymentModule } from './payment/payment.module';
import { RefundModule } from './refund/refund.module';
import { TaxModule } from './tax/tax.module';
import { DashboardModule } from './dashboard/dashboard.module';
import { AnalyticsModule } from './analytics/analytics.module';
import { AuditModule } from './audit/audit.module';
import { SettingsModule } from './settings/settings.module';
import { PrinterModule } from './printer/printer.module';
import { ScannerModule } from './scanner/scanner.module';
import { TerminalModule } from './terminal/terminal.module';
import { NotificationModule } from './notification/notification.module';
import { EmailModule } from './email/email.module';
import { SmsModule } from './sms/sms.module';
import { OnlineOrderModule } from './online-order/online-order.module';
import { DeliveryModule } from './delivery/delivery.module';
import { PromotionModule } from './promotion/promotion.module';
import { MembershipModule } from './membership/membership.module';
import { CouponModule } from './coupon/coupon.module';
import { CatalogModule } from './catalog/catalog.module';
import { DriverModule } from './driver/driver.module';
import { DeviceModule } from './device/device.module';
import { InvoiceModule } from './invoice/invoice.module';
import { CashManagementModule } from './cash-management/cash-management.module';

@Module({
  imports: [AuthModule, StoreModule, ShiftModule, ProductModule, CartModule, TransactionModule, ReceiptModule, ReportModule, InventoryModule, SupplierModule, PurchaseOrderModule, StockTransferModule, EmployeeModule, PayrollModule, AttendanceModule, CustomerModule, LoyaltyModule, GiftCardModule, PaymentModule, RefundModule, TaxModule, DashboardModule, AnalyticsModule, AuditModule, SettingsModule, PrinterModule, ScannerModule, TerminalModule, NotificationModule, EmailModule, SmsModule, OnlineOrderModule, DeliveryModule, PromotionModule, MembershipModule, CouponModule, CatalogModule, DriverModule, DeviceModule, InvoiceModule, CashManagementModule],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
