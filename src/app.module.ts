import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { AuthController, AuthGuard, RolesGuard } from './auth/auth';
import { DbService } from './db/db.service';
import { ReceiptsController } from './receipts/receipts.controller';
import { ReceiptsService } from './receipts/receipts.service';
import { HealthController } from './health.controller';
import { InventoryController } from './inventory/inventory.controller';
import { DashboardController } from './dashboard/dashboard.controller';
import { MpesaController, MpesaService } from './mpesa/mpesa.controller';
import { ReceiptRecoveryController } from './receipts/recovery.controller';
import { PlatformFinanceController } from './platform-finance/platform-finance.controller';
import { BusinessProfileController } from './business/business-profile.controller';
import { CustomersController } from './customers/customers.controller';
import { StaffController } from './staff/staff.controller';
import { EmailVerificationService } from './notifications/email-verification.service';
import { WhatsAppReceiptService } from './notifications/whatsapp-receipt.service';
import { ReferralsController } from './referrals/referrals.controller';
import { SecondHandPhoneDeclarationsController } from './second-hand/second-hand-declarations.controller';
import { SecondHandSpecialRecoveryController } from './second-hand/second-hand-special-recovery.controller';

@Module({
  imports: [JwtModule.register({ global: true, secret: process.env.JWT_SECRET })],
  controllers: [HealthController, AuthController, ReceiptsController, InventoryController, DashboardController, MpesaController, ReceiptRecoveryController, PlatformFinanceController, BusinessProfileController, CustomersController, StaffController, ReferralsController, SecondHandPhoneDeclarationsController, SecondHandSpecialRecoveryController],
  providers: [DbService, ReceiptsService, EmailVerificationService, WhatsAppReceiptService, AuthGuard, RolesGuard, { provide: MpesaService, useClass: MpesaService }],
})
export class AppModule {}
