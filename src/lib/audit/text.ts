const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/g;
const MAX_LENGTH = 200;

export function printable(value: unknown, maxLength = MAX_LENGTH): string {
  if (value === null || value === undefined) {
    return 'n/a';
  }

  if (typeof value === 'string') {
    const cleaned = value.replace(CONTROL_CHARACTERS, ' ').replace(/\s+/g, ' ').trim();
    if (cleaned.length === 0) {
      return 'n/a';
    }
    return cleaned.length > maxLength ? `${cleaned.slice(0, maxLength)}...` : cleaned;
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }

  return Array.isArray(value) ? 'array' : typeof value;
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}
