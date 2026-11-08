import {
  ArgumentsHost,
  BadRequestException,
  Catch,
  ExceptionFilter,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { RpcException } from '@nestjs/microservices';
import { status } from '@grpc/grpc-js';
import { Observable, throwError } from 'rxjs';

/**
 * services เดิมยัง throw Nest HttpException ธรรมดา (NotFoundException/BadRequestException/
 * UnauthorizedException) เหมือนตอนเป็น REST — ไม่แก้ service ให้รู้จัก gRPC status ตรง ๆ
 * เพื่อให้ logic เดิม (assertTenantAllowed ฯลฯ) reuse ได้ ที่นี่จุดเดียวคือจุดแปลงเป็น
 * grpc.status ให้ตรงกับ docs/partner-api-guide.md
 */
@Catch()
export class PartnerGrpcExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(PartnerGrpcExceptionFilter.name);

  catch(exception: unknown, _host: ArgumentsHost): Observable<never> {
    if (exception instanceof RpcException) {
      return throwError(() => exception.getError());
    }
    if (exception instanceof NotFoundException) {
      return throwError(() => ({ code: status.NOT_FOUND, message: exception.message }));
    }
    if (exception instanceof BadRequestException) {
      return throwError(() => ({ code: status.INVALID_ARGUMENT, message: exception.message }));
    }
    if (exception instanceof UnauthorizedException) {
      return throwError(() => ({ code: status.UNAUTHENTICATED, message: exception.message }));
    }

    this.logger.error('Unhandled exception in Partner gRPC surface', exception as Error);
    return throwError(() => ({ code: status.INTERNAL, message: 'Internal server error' }));
  }
}
