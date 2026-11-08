import { Controller, Get, Param, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { JwtPayloadDto } from '../common/dto/payload.dto';
import { GraphService, ProbeSeries } from './graph.service';
import { JwtAuthGuard } from '../common/guards/jwt.guard';
import { DeviceAssignmentService } from '../device/device-assignment.service';
import { QueryGraphDto } from './dto/query-graph.dto';

@ApiTags('graph')
@ApiBearerAuth('jwt')
@Controller('graph')
@UseGuards(JwtAuthGuard)
export class GraphController {
  constructor(
    private readonly graphService: GraphService,
    private readonly assignments: DeviceAssignmentService,
  ) {}

  /**
   * รับได้ทั้ง serial ของกล่องที่ติดตั้งอยู่ และ staticName ของจุดติดตั้ง
   * ทั้งสองแบบถูก resolve เป็น deviceId ก่อน query จึงได้กราฟต่อเนื่องข้ามการสลับเครื่อง
   *
   * คืน 1 series ต่อ 1 probe (ไม่ใช่ log แบน ๆ) เพราะ 1 device มีได้หลาย probe
   */
  @Get(':serialOrName')
  async series(
    @Param('serialOrName') serialOrName: string,
    @Query() query: QueryGraphDto,
    @Req() req: Request & { user: JwtPayloadDto },
  ): Promise<ProbeSeries[]> {
    const deviceId = await this.assignments.resolveDeviceIdOrThrow(serialOrName, req.user.scope);
    return this.graphService.series(deviceId, query);
  }
}
