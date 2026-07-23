import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Request, Response } from 'express';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import { HTTP_MESSAGES } from '../constants/http.constants';
import { SKIP_INTERCEPTOR } from '../decorators/skip-interceptor.decorator';

export interface StandardResponse<T> {
  success: boolean;
  message: string;
  data: T | null;
  timestamp: string;
  statusCode: number;
}

@Injectable()
export class ResponseInterceptor<T> implements NestInterceptor<T, StandardResponse<T>> {
  constructor(private readonly reflector: Reflector) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<StandardResponse<T>> {
    const skip = this.reflector.get<boolean>(SKIP_INTERCEPTOR, context.getHandler());
    if (skip) {
      return next.handle();
    }

    const request = context.switchToHttp().getRequest<Request>();
    const response = context.switchToHttp().getResponse<Response>();

    return next.handle().pipe(
      map((data: T) => {
        let message: string = HTTP_MESSAGES.SUCCESS;
        switch (request.method) {
          case 'POST':
            message = HTTP_MESSAGES.CREATED;
            break;
          case 'PUT':
          case 'PATCH':
            message = HTTP_MESSAGES.UPDATED;
            break;
          case 'DELETE':
            message = HTTP_MESSAGES.DELETED;
            break;
        }

        return {
          success: true,
          message,
          data: data ?? null,
          timestamp: new Date().toISOString(),
          statusCode: response.statusCode || 200,
        };
      }),
    );
  }
}
