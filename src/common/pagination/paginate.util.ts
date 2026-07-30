import { PaginationQueryDto } from '../dto/pagination-query.dto';
import { Paginated } from './paginated.dto';

export function paginationSkip(pagination: PaginationQueryDto): number {
  return ((pagination.page ?? 1) - 1) * (pagination.limit ?? 20);
}

export function toPaginated<T>(
  data: T[],
  total: number,
  pagination: PaginationQueryDto,
): Paginated<T> {
  const page = pagination.page ?? 1;
  const limit = pagination.limit ?? 20;
  return new Paginated(data, { page, limit, total, totalPages: Math.ceil(total / limit) || 0 });
}
