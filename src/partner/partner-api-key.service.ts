import { randomBytes, createHash } from 'node:crypto';
import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreatePartnerApiKeyDto } from './dto/create-partner-api-key.dto';
import { PaginationQueryDto } from '../common/dto/pagination-query.dto';
import { Paginated } from '../common/pagination/paginated.dto';
import { paginationSkip, toPaginated } from '../common/pagination/paginate.util';

const KEY_PREFIX = 'pk_live_';

export interface PartnerApiKeyContext {
  id: string;
  name: string;
  wards: Set<string>;
}

export interface CreatedPartnerApiKey {
  id: string;
  name: string;
  /** โชว์ครั้งเดียวตอนสร้าง — หลังจากนี้ไม่มีทางเรียกดู plaintext กลับมาได้อีก */
  apiKey: string;
  keyPrefix: string;
  wards: string[];
  createAt: Date;
}

export interface PartnerApiKeySummary {
  id: string;
  name: string;
  keyPrefix: string;
  revokedAt: Date | null;
  wards: string[];
  createAt: Date;
}

function hashKey(rawKey: string): string {
  return createHash('sha256').update(rawKey).digest('hex');
}

/**
 * ออก/จัดการ Partner API Key — key จริงไม่ถูกเก็บที่ไหนเลยหลังสร้าง มีแค่ SHA-256 hash
 * ใน DB เท่านั้น (มาตรฐานเดียวกับ Stripe/GitHub token)
 * scope ด้วย ward ตาม ADR-0003 (แทน per-serial allowlist เดิมของ ADR-0002)
 */
@Injectable()
export class PartnerApiKeyService {
  constructor(private readonly prisma: PrismaService) {}

  async create(dto: CreatePartnerApiKeyDto): Promise<CreatedPartnerApiKey> {
    const rawKey = `${KEY_PREFIX}${randomBytes(32).toString('base64url')}`;
    const keyPrefix = rawKey.slice(0, KEY_PREFIX.length + 8);

    const created = await this.prisma.partnerApiKeys.create({
      data: {
        name: dto.name,
        keyHash: hashKey(rawKey),
        keyPrefix,
        wards: {
          create: dto.wards.map((ward) => ({ ward })),
        },
      },
      include: { wards: true },
    });

    return {
      id: created.id,
      name: created.name,
      apiKey: rawKey,
      keyPrefix: created.keyPrefix,
      wards: created.wards.map((w) => w.ward),
      createAt: created.createAt,
    };
  }

  async findAll(pagination: PaginationQueryDto): Promise<Paginated<PartnerApiKeySummary>> {
    const [rows, total] = await Promise.all([
      this.prisma.partnerApiKeys.findMany({
        include: { wards: true },
        orderBy: { createAt: 'desc' },
        skip: paginationSkip(pagination),
        take: pagination.limit ?? 20,
      }),
      this.prisma.partnerApiKeys.count(),
    ]);
    return toPaginated(rows.map(toSummary), total, pagination);
  }

  async findOne(id: string): Promise<PartnerApiKeySummary> {
    const row = await this.prisma.partnerApiKeys.findUnique({
      where: { id },
      include: { wards: true },
    });
    if (!row) throw new NotFoundException(`Partner API key ${id} not found`);
    return toSummary(row);
  }

  /** soft-revoke — เก็บแถวไว้เพื่อรักษาประวัติ usage log ที่อ้างถึง key นี้ */
  async revoke(id: string): Promise<PartnerApiKeySummary> {
    await this.findOne(id);
    const row = await this.prisma.partnerApiKeys.update({
      where: { id },
      data: { revokedAt: new Date() },
      include: { wards: true },
    });
    return toSummary(row);
  }

  /** ใช้โดย GrpcApiKeyAuthGuard เท่านั้น — คืน null ถ้า key ไม่ถูกต้อง/ถูก revoke ไปแล้ว */
  async validate(rawKey: string): Promise<PartnerApiKeyContext | null> {
    const row = await this.prisma.partnerApiKeys.findUnique({
      where: { keyHash: hashKey(rawKey) },
      include: { wards: true },
    });
    if (!row || row.revokedAt) return null;
    return { id: row.id, name: row.name, wards: new Set(row.wards.map((w) => w.ward)) };
  }
}

function toSummary(row: {
  id: string;
  name: string;
  keyPrefix: string;
  revokedAt: Date | null;
  createAt: Date;
  wards: { ward: string }[];
}): PartnerApiKeySummary {
  return {
    id: row.id,
    name: row.name,
    keyPrefix: row.keyPrefix,
    revokedAt: row.revokedAt,
    wards: row.wards.map((w) => w.ward),
    createAt: row.createAt,
  };
}
