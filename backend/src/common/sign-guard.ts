/**
 * V5.0.19i（Q-03 DRY）：必签校验统一实现。
 * 原先 inventory.module.ts 与 purchase.module.ts 各持一份逐字相同的 private assertSigned，
 * 现抽到公共层；调用方保留薄委托（this.settings 门店级配置由调用侧注入）。
 * 行为口径：auth.sign_required_scenes 配置含该场景且单据 sign_record_id 为空 → 50018 拒绝过审。
 */
import { BizException } from './http';
import { cx } from './db';

/** 与 modules/settings.module.ts 的 SettingsService.getJson 同形（避免循环依赖，只依赖方法签名） */
export interface SignScenesProvider {
  getJson(key: string, defaultValue: any): Promise<any>;
}

export async function assertSigned(
  settings: SignScenesProvider,
  c: any, scene: string, table: string, bizId: number, docNo: string,
): Promise<void> {
  const scenes = await settings.getJson('auth.sign_required_scenes', []);
  if (!Array.isArray(scenes) || !scenes.includes(scene)) return;
  const rows = await cx(c, `SELECT sign_record_id FROM ${table} WHERE id=$1`, [bizId]);
  if (rows.length && !rows[0].sign_record_id) {
    throw new BizException(50018, `${docNo} 尚未电子签字，按"必签才能过审"配置请先在单据列表补签后再审核`);
  }
}
