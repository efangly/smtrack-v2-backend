import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { GraphService } from './graph.service';
import { JwtAuthGuard } from '../common/guards/jwt.guard';
import { DeviceAssignmentService } from '../device/device-assignment.service';

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
   */
  @Get(':serialOrName')
  async series(@Param('serialOrName') serialOrName: string) {
    const deviceId = await this.assignments.resolveDeviceIdOrThrow(serialOrName);
    return this.graphService.series(deviceId);
  }
}
