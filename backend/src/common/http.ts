import {
  ExceptionFilter, Catch, ArgumentsHost, HttpException,
  CallHandler, ExecutionContext, Injectable, NestInterceptor,
} from '@nestjs/common';
import { Observable, map } from 'rxjs';

/** 业务异常：code 按《开发执行文件》第 4 节错误码段（50xxx 业务规则等） */
export class BizException extends HttpException {
  constructor(public readonly bizCode: number, msg: string, httpStatus = 400) {
    super(msg, httpStatus);
  }
}

/**
 * V5.0.15 极限测试发现：所有写接口都缺「长度/范围」校验，用户输入超长或越界值时
 * 由 PostgreSQL 抛 22xxx/23xxx 错误 → 一律被当成 500「系统错误」，用户只看到一句
 * 无意义的提示，既不知哪里超了、也不知道上限是多少。
 * 这里把「可由用户输入直接触发」的数据库错误统一映射成 4xx + 可操作的中文提示，
 * 真正的服务端故障仍走 500。映射表按 PG SQLSTATE 分类，详情仍落服务端日志。
 */
const PG_USER_ERRORS: { re: RegExp; code: number; msg: (m: RegExpMatchArray) => string }[] = [
  { re: /value too long for type character varying\((\d+)\)/i, code: 40004, msg: m => `内容超长：该字段最多 ${m[1]} 个字符，请精简后再保存` },
  { re: /value too long for type (\w+)/i, code: 40004, msg: m => `内容超出字段容量（${m[1]}），请缩短后再保存` },
  { re: /numeric field overflow|value out of range:.*numeric/i, code: 40005, msg: () => '数值超出允许范围（超出该字段的数值上限），请核对后重试' },
  { re: /integer out of range/i, code: 40005, msg: () => '整数超出允许范围（上限约 21 亿），请核对后重试' },
  { re: /smallint out of range/i, code: 40005, msg: () => '整数超出允许范围（上限 32767），请核对后重试' },
  { re: /division by zero/i, code: 40006, msg: () => '除数为 0，无法计算，请核对输入' },
  { re: /invalid input syntax for type (\w+)/i, code: 40007, msg: m => `格式不正确：${m[1]} 类型无法解析该输入` },
  { re: /null value in column "([^"]+)" of relation "([^"]+)" violates not-null constraint/i, code: 40008, msg: m => `缺少必填信息：${m[1]} 不能为空` },
  { re: /duplicate key value violates unique constraint "([^"]+)"/i, code: 40009, msg: m => `已存在重复记录（${m[1]}），请勿重复提交` },
  { re: /foreign key constraint "([^"]+)" is not satisfied|violates foreign key constraint/i, code: 40010, msg: () => '关联数据不存在或已被删除，请刷新后重试' },
  { re: /new row violates check constraint "([^"]+)"/i, code: 40011, msg: m => `不符合业务规则（${m[1]}），请核对后重试` },
  { re: /cannot insert multiple commands into a prepared statement/i, code: 40012, msg: () => '参数不合法，请检查后重试' },
];

/** 统一响应包：{ code, msg, data }（成功由拦截器包装，失败由过滤器包装） */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse();
    if (exception instanceof BizException) {
      res.status(exception.getStatus()).json({ code: exception.bizCode, msg: exception.message, data: null });
    } else if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body: any = exception.getResponse();
      const msg = typeof body === 'string' ? body : (body.message ?? exception.message);
      res.status(status).json({ code: status * 100, msg: Array.isArray(msg) ? msg.join('; ') : msg, data: null });
    } else {
      const detail = exception instanceof Error ? (exception.stack || exception.message) : String(exception);
      // V4.14.4 安全加固：未知异常详情只进服务端日志，不向客户端透传（原实现会把
      // PG 报错原文（含表名/约束名/SQL 片段）返回给前端，属于信息泄露）
      console.error('[未处理异常]', detail);
      try {
        const fs = require('fs');
        const path = require('path');
        const dir = path.join(__dirname, '..', '..', 'logs');
        fs.mkdirSync(dir, { recursive: true });
        fs.appendFileSync(path.join(dir, 'error.log'),
          `[${new Date().toISOString()}] [filter] ${detail}\n`);
      } catch { /* 日志失败不影响主流程 */ }
      // body-parser 超限（PayloadTooLargeError，type=entity.too.large）→ 413 中文提示
      const tooLarge = exception instanceof Error && (exception as any).type === 'entity.too.large';
      if (tooLarge) {
        res.status(413).json({ code: 41300, msg: '文件过大：请压缩后再上传（单张上限约 15MB）', data: null });
        return;
      }
      // V5.0.15：用户输入导致的数据库错误（超长/越界/重复/外键/非空）→ 4xx 可操作提示，不当 500
      for (const r of PG_USER_ERRORS) {
        const m = String(detail).match(r.re);
        if (m) {
          res.status(400).json({ code: r.code, msg: r.msg(m), data: null });
          return;
        }
      }
      // 数据库连接类异常给部署者友好提示（不透出连接串/表结构细节）
      const isDbDown = /ECONNREFUSED|connection terminated|password authentication|DATABASE_URL/i.test(detail);
      // V4.18.9 规范化：TypeError 多为客户端参数类型混淆（数组传成字符串等），按业务参数错误 40003 返回，
      // 不再归为 50000 系统错误（渗透测试 OBSERVE 项）；详情仍落服务端日志
      const isTypeErr = exception instanceof TypeError;
      res.status(isTypeErr ? 400 : 500).json({
        code: isTypeErr ? 40003 : 50000,
        msg: isDbDown ? '数据库连接异常，请检查数据库服务是否已启动（DATABASE_URL）'
          : isTypeErr ? '请求参数类型或取值不合法，请检查后重试'
            : '系统错误，请稍后重试（详情见服务端 logs/error.log）',
        data: null,
      });
    }
  }
}

@Injectable()
export class WrapInterceptor implements NestInterceptor {
  intercept(_ctx: ExecutionContext, next: CallHandler): Observable<any> {
    return next.handle().pipe(map(data => ({ code: 0, msg: 'ok', data: data ?? null })));
  }
}
