import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { Prisma } from '../../generated/prisma/client';
import { RestoreInProgressException } from '../exceptions/restore-in-progress.exception';

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    // 202 ไม่ใช่ error — ข้อมูลกำลังถูก restore จาก archive ให้ client ยิงซ้ำตาม Retry-After
    if (exception instanceof RestoreInProgressException) {
      response.setHeader('Retry-After', String(exception.retryAfterSeconds));
      response.status(HttpStatus.ACCEPTED).json({
        success: true,
        message: (exception.getResponse() as { message: string }).message,
        data: null,
        retryAfterSeconds: exception.retryAfterSeconds,
        statusCode: HttpStatus.ACCEPTED,
        timestamp: new Date().toISOString(),
      });
      return;
    }

    let status =
      exception instanceof HttpException ? exception.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;
    let message: unknown = exception instanceof Error ? exception.message : 'Internal server error';

    if (exception instanceof HttpException) {
      const body = exception.getResponse();
      message =
        typeof body === 'object' && body !== null ? (body as { message?: unknown }).message : body;
    }

    if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      switch (exception.code) {
        case 'P2002':
          message = `The value for field '${exception.meta?.target}' already exists`;
          status = HttpStatus.CONFLICT;
          break;
        case 'P2003':
          message = 'Foreign key constraint failed';
          status = HttpStatus.BAD_REQUEST;
          break;
        case 'P2024':
          message = 'Timed out fetching a new connection from the connection pool';
          status = HttpStatus.INTERNAL_SERVER_ERROR;
          break;
        case 'P2025':
          message = 'The requested resource was not found';
          status = HttpStatus.NOT_FOUND;
          break;
        default:
          message = exception.message;
          status = HttpStatus.BAD_REQUEST;
          break;
      }
    }

    if (status >= HttpStatus.INTERNAL_SERVER_ERROR) {
      this.logger.error(
        `${request.method} ${request.url}`,
        exception instanceof Error ? exception.stack : String(exception),
      );
    } else if (status >= HttpStatus.BAD_REQUEST && status !== HttpStatus.UNAUTHORIZED) {
      this.logger.warn(`${request.method} ${request.url} — ${String(message)}`);
    }

    response.status(status).json({
      message,
      success: false,
      data: null,
      traceStack:
        process.env.NODE_ENV === 'development' && exception instanceof Error
          ? exception.stack
          : undefined,
    });
  }
}
