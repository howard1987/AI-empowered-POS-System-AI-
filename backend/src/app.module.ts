import { Module, Controller, Get, Res } from '@nestjs/common';
import { Response } from 'express';
import { APP_GUARD, APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';
import { AuthGuard, Public } from './common/auth';
import { pool } from './common/db';
import { AllExceptionsFilter, WrapInterceptor } from './common/http';
import { AuthModule } from './modules/auth.module';
import { SettingsModule } from './modules/settings.module';
import { ProductsModule } from './modules/products.module';
import { InventoryModule } from './modules/inventory.module';
import { PurchaseModule } from './modules/purchase.module';
import { MembersModule } from './modules/members.module';
import { DividendModule } from './modules/dividend.module';
import { SalesModule } from './modules/sales.module';
import { ReportsModule } from './modules/reports.module';
import { PromotionsModule } from './modules/promotions.module';
import { PosModule } from './modules/pos.module';
import { AiModule } from './modules/ai.module';
import { CouponsModule } from './modules/coupons.module';
import { ShiftModule } from './modules/shift.module';
import { RefundModule } from './modules/refund.module';
import { MemberAppModule } from './modules/member-app.module';
import { MarketingModule } from './modules/marketing.module';
import { UploadModule } from './modules/upload.module';
import { BigCustomerModule } from './modules/bigcustomer.module';
import { AibrainModule } from './modules/aibrain.module';
import { DeviceModule } from './modules/device.module';
import { TablesModule } from './modules/tables.module';
import { DisplayModule } from './modules/display.module';
import { BasicModule } from './modules/basic.module';
import { AdminResetModule } from './modules/admin.reset';
import { FraudController } from './modules/fraud.module';
import { MemberProfileController } from './modules/profile.module';
import { AiMarketController } from './modules/ai.market';
import { AiPricingController } from './modules/ai.pricing';
import { FinanceReconModule } from './modules/finance.recon';
import { AiAntileakModule } from './modules/ai.antileak';
import { PayGatewayModule } from './modules/pay.gateway';
import { SalesJobsModule } from './modules/sales.jobs';
import { RemoteSignController } from './modules/remote.sign';
import { TtsModule } from './modules/tts.module';
import { ScaleTransmissionModule } from './modules/scale-transmission.module';
import { ChainModule } from './modules/chain.module';        // V5.0.0 连锁：总部组织与门店管理（批次2）
import { SyncModule } from './modules/sync.module';          // V5.0.0 连锁：同步层（批次4A）
import { ReturnChainModule } from './modules/return-chain.module'; // V5.0.0 连锁：跨店退货/往来/差异单（批次4B）
import { MemberChainModule } from './modules/member-chain.module'; // V5.0.0 连锁：会员连锁 跨店资产/镜像（批次5）

@Controller()
class HealthController {
  @Public()
  @Get('health')
  async health() {
    // V4.25.8：连带探测数据库，把 db 状态一并返回（供监控/启动脚本判断）。
    // 仍返回 200，避免收银端/桌面端探活把「DB 未就绪」误判成「后端崩溃」而进错误页；
    // 启动脚本改判 PG 端口 + 本字段，确保 DB 真就绪才开浏览器。
    let db = 'ok';
    try {
      // 加 1 秒超时：避免 DB 瞬断时 /health 被 pool 挂住，导致启动脚本空等。
      await Promise.race([
        pool.query('select 1'),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('db health timeout')), 1000)),
      ]);
    } catch (e) {
      db = 'down';
    }
    return { status: 'ok', service: 'cashier-backend', version: process.env.APP_VERSION || (() => { try { return require('fs').readFileSync(require('path').join(__dirname, '..', 'version.txt'), 'utf8').trim(); } catch { return '0.1.0'; } })(), db, time: new Date().toISOString() };
  }
}

@Module({
  imports: [
    AuthModule,
    SettingsModule,
    ProductsModule,
    InventoryModule,
    PurchaseModule,
    MembersModule,
    DividendModule,
    SalesModule,
    SalesJobsModule,
    ReportsModule,
    PromotionsModule,
    PosModule,
    AiModule,
    CouponsModule,
    ShiftModule,
    RefundModule,
    MemberAppModule,
    MarketingModule,
    UploadModule,
    BigCustomerModule,
    AibrainModule,
    DeviceModule,
    TablesModule,
    DisplayModule,
    BasicModule,
    AdminResetModule,
    FinanceReconModule,
    AiAntileakModule,
    PayGatewayModule,
    TtsModule,                                        // V4.24.1：服务端离线神经语音（piper，全端统一播报）
    ScaleTransmissionModule,                          // V4.26.0：条码秤/标签秤 PLU 下发（传秤小工具）
    ChainModule,                                      // V5.0.0：连锁总部组织 / 门店管理（批次2）
    SyncModule,                                       // V5.0.0：同步层 push/pull/对账（批次4A）
    ReturnChainModule,                                // V5.0.0：跨店退货/门店往来/差异单（批次4B）
    MemberChainModule,                                // V5.0.0：会员连锁 跨店资产/镜像/建档（批次5）
  ],
  controllers: [HealthController, FraudController, MemberProfileController, AiMarketController, AiPricingController, RemoteSignController],
  providers: [
    { provide: APP_GUARD, useClass: AuthGuard },      // 全局鉴权（@Public 例外）
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    { provide: APP_INTERCEPTOR, useClass: WrapInterceptor },
  ],
})
export class AppModule {}
