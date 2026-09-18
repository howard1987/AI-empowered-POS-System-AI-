/**
 * 站内提醒（V4.14.6 RV-07）：告警触达到人（先落库，前端顶栏铃铛拉取+红点）
 * 收件范围按权限点 perm 匹配（员工 JWT 里带 perms，'*'=全员）；
 * batch_key 非空时依赖 061 的部分唯一索引做幂等（同批次重复触发不重复提醒）。
 */
import { q } from './db';

export async function notifyStaff(
  storeId: number,
  kind: string,
  title: string,
  detail: any = {},
  perm = 'sys.settings',
  batchKey: string | null = null,
) {
  await q(
    `INSERT INTO notices (store_id, kind, title, detail, perm, batch_key)
     VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,
    [storeId, kind, title, JSON.stringify(detail ?? {}), perm, batchKey],
  );
}
