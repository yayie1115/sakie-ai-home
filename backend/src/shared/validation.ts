export class ValidationError extends Error {
  readonly status = 400;
}
export function objectBody(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ValidationError('JSON body must be an object');
  return value as Record<string, unknown>;
}
export function text(value: unknown, field: string, max = 100000): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new ValidationError(field + ' must be a non-empty string, max length ' + max);
  return value.trim();
}
export function date(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new ValidationError('date must be YYYY-MM-DD');
  const parsed = new Date(value + 'T00:00:00.000Z');
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) throw new ValidationError('date must be a valid calendar date');
  return value;
}
export function timestamp(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) throw new ValidationError('time must be ISO 8601 with a timezone');
  date(value.slice(0, 10));
  if (Number(value.slice(11,13)) > 23 || Number(value.slice(14,16)) > 59 || Number(value.slice(17,19)) > 59) throw new ValidationError('Invalid time');
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new ValidationError('Invalid time');
  return parsed.toISOString();
}
export function importance(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 5) throw new ValidationError('importance must be an integer from 1 to 5');
  return value;
}
export function pageNumber(value: unknown, fallback: number, field: string, min: number, max: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !/^\d+$/.test(value)) throw new ValidationError('Invalid ' + field);
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < min || n > max) throw new ValidationError('Invalid ' + field);
  return n;
}
