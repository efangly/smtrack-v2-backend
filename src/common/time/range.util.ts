import { BadRequestException } from '@nestjs/common';

export enum TimeRange {
  DAY = '1d',
  WEEK = '7d',
  MONTH = '30d',
  CUSTOM = 'custom',
}

const RANGE_DAYS: Record<Exclude<TimeRange, TimeRange.CUSTOM>, number> = {
  [TimeRange.DAY]: 1,
  [TimeRange.WEEK]: 7,
  [TimeRange.MONTH]: 30,
};

export function resolveRange(
  range: TimeRange,
  from?: string,
  to?: string,
): { from: Date; to: Date } {
  if (range === TimeRange.CUSTOM) {
    if (!from || !to) {
      throw new BadRequestException('from and to are required when range=custom');
    }
    return { from: new Date(from), to: new Date(to) };
  }
  const now = new Date();
  const days = RANGE_DAYS[range];
  return { from: new Date(now.getTime() - days * 24 * 60 * 60 * 1000), to: now };
}
