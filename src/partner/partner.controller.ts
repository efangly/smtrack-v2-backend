import { Controller, UseFilters, UseGuards } from '@nestjs/common';
import { GrpcMethod, RpcException } from '@nestjs/microservices';
import { status } from '@grpc/grpc-js';
import { PartnerService } from './partner.service';
import { GrpcApiKeyAuthGuard, WithPartnerApiKey } from './partner-grpc.guard';
import { GrpcPartnerRateLimitGuard } from './partner-grpc-rate-limit.guard';
import { PartnerGrpcExceptionFilter } from './partner-grpc-exception.filter';
import { SkipInterceptor } from '../common/decorators/skip-interceptor.decorator';

interface GetDeviceSnapshotRequest {
  serial: string;
}

interface ListDevicesByWardRequest {
  ward: string;
  page?: number;
  limit?: number;
}

// Third-party facing gRPC surface — ดู src/partner/partner.proto สำหรับ contract เต็ม และ
// docs/partner-api-guide.md สำหรับ integration guide auth ผ่าน x-api-key metadata
// (GrpcApiKeyAuthGuard) ไม่ใช่ jwt/device-jwt เหมือน REST endpoint อื่นในโปรเจค
@Controller()
@UseGuards(GrpcApiKeyAuthGuard, GrpcPartnerRateLimitGuard)
@UseFilters(PartnerGrpcExceptionFilter)
export class PartnerController {
  constructor(private readonly partnerService: PartnerService) {}

  // ResponseInterceptor เป็น global interceptor ที่ตั้งใจไว้สำหรับ HTTP เท่านั้น แต่ Nest
  // เอาไปรันกับ @GrpcMethod ด้วยเพราะ hybrid app เดียวกัน (แกะ metadata ผ่าน SKIP_INTERCEPTOR
  // ไม่ใช่ transport type) — ถ้าไม่ skip จะเอา { success, message, data, ... } ห่อ response
  // ทับ field ของ proto message จนกลายเป็น object ว่างตอน grpc-js serialize (ไม่ match field ไหนเลย)
  @SkipInterceptor()
  @GrpcMethod('PartnerService', 'GetDeviceSnapshot')
  async getDeviceSnapshot(request: GetDeviceSnapshotRequest & WithPartnerApiKey) {
    if (!request.serial) {
      throw new RpcException({ code: status.INVALID_ARGUMENT, message: 'serial is required' });
    }
    const apiKey = request.__partnerApiKey!;
    let statusCode = status.OK;
    try {
      const { device, timeseries } = await this.partnerService.getDeviceSnapshot(
        apiKey,
        request.serial,
      );
      return {
        device,
        timeseries: timeseries.map((point) => ({
          ...point,
          sendTime: point.sendTime.toISOString(),
        })),
      };
    } catch (err) {
      statusCode = errorStatusCode(err);
      throw err;
    } finally {
      void this.partnerService.logRequest(
        apiKey.id,
        { serial: request.serial },
        'partner.PartnerService/GetDeviceSnapshot',
        statusCode,
      );
    }
  }

  @SkipInterceptor()
  @GrpcMethod('PartnerService', 'ListDevicesByWard')
  async listDevicesByWard(request: ListDevicesByWardRequest & WithPartnerApiKey) {
    if (!request.ward) {
      throw new RpcException({ code: status.INVALID_ARGUMENT, message: 'ward is required' });
    }
    const apiKey = request.__partnerApiKey!;
    let statusCode = status.OK;
    try {
      const result = await this.partnerService.listDevicesByWard(apiKey, request.ward, {
        page: request.page,
        limit: request.limit,
      });
      return {
        devices: result.devices.map(({ device, latest }) => ({
          device,
          latest: latest ? { ...latest, sendTime: latest.sendTime.toISOString() } : undefined,
        })),
        total: result.total,
        page: result.page,
        limit: result.limit,
      };
    } catch (err) {
      statusCode = errorStatusCode(err);
      throw err;
    } finally {
      void this.partnerService.logRequest(
        apiKey.id,
        { ward: request.ward },
        'partner.PartnerService/ListDevicesByWard',
        statusCode,
      );
    }
  }
}

function errorStatusCode(err: unknown): number {
  if (err instanceof RpcException) {
    const error = err.getError();
    if (typeof error === 'object' && error !== null && 'code' in error) {
      return (error as { code: number }).code;
    }
  }
  return status.INTERNAL;
}
