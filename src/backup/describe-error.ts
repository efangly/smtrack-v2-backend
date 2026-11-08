/**
 * ข้อความ error ที่อ่านรู้เรื่องสำหรับ log และ archive_job_run
 *
 * AWS SDK/Node บางกรณี (เช่นต่อ endpoint ไม่ได้ → AggregateError ของ ECONNREFUSED ทั้ง IPv4/IPv6)
 * มี `message` เป็นสตริงว่าง ถ้าใช้ `err.message` ตรง ๆ เราจะบันทึกว่า "failed: " โดยไม่รู้สาเหตุ
 */
export function describeError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const e = err as Error & { code?: string; errors?: unknown[] };
  const parts: string[] = [];
  if (e.message) parts.push(e.message);
  if (e.code && !parts.some((p) => p.includes(e.code as string))) parts.push(e.code);
  if (Array.isArray(e.errors) && e.errors.length > 0) {
    const nested = e.errors
      .map((n) => (n instanceof Error ? ((n as { code?: string }).code ?? n.message) : String(n)))
      .filter(Boolean);
    if (nested.length > 0) parts.push(`[${[...new Set(nested)].join(', ')}]`);
  }
  return parts.length > 0 ? parts.join(' ') : e.name || 'Error';
}
