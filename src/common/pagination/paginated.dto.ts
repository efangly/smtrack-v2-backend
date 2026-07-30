export class PaginationMeta {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

/** marker class ให้ ResponseInterceptor แยกแยะ response ที่ paginate ด้วย instanceof */
export class Paginated<T> {
  constructor(
    public data: T[],
    public meta: PaginationMeta,
  ) {}
}
