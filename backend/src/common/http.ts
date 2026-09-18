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
