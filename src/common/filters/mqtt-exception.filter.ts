import { ArgumentsHost, Catch, ExceptionFilter, Logger } from '@nestjs/common';
import { SpanStatusCode, trace } from '@opentelemetry/api';

/**
 * MQTT handler ไม่มี HTTP response ให้ throw กลับ — filter นี้จับ error
 * จาก @EventPattern/@MessagePattern handler แล้ว log ไว้ ไม่ให้ล้ม process
 */
@Catch()
export class MqttExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(MqttExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToRpc();
    const data = ctx.getData();

    // filter นี้กลืน error ไว้ — ถ้าไม่บันทึกลง span error จะหายไปจาก Tempo ด้วย
    const span = trace.getActiveSpan();
    if (span) {
      const error = exception instanceof Error ? exception : new Error(String(exception));
      span.recordException(error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
    }

    this.logger.error(
      `MQTT handler error: ${exception instanceof Error ? exception.message : String(exception)}`,
      exception instanceof Error ? exception.stack : undefined,
    );
    this.logger.debug(`Offending payload: ${JSON.stringify(data)}`);
    // ไม่ re-throw — กลืน error ไว้ที่นี่เพื่อไม่ให้ล้ม MQTT consumer
  }
}
