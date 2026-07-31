import { PartialType } from '@nestjs/swagger';
import { CreateFirmwareDto } from './create-firmware.dto';

// version ระบุตัวตนของเวอร์ชั่นนั้นตั้งแต่สร้าง ไม่ให้แก้ย้อนหลัง (ต้องการเวอร์ชั่นใหม่ต้องอัปโหลดรายการใหม่)
// — ตัดออกใน service เหมือน warranties ตัด serial / device-repair ตัด serial
export class UpdateFirmwareDto extends PartialType(CreateFirmwareDto) {}
