import { createHash } from 'node:crypto';

export const canonicalAuditJson = (value: unknown): string => {
  if (
    value === null ||
    typeof value === 'boolean' ||
    typeof value === 'string'
  ) {
    return JSON.stringify(value);
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${Array.from(value, canonicalAuditJson).join(',')}]`;
  }

  if (
    typeof value === 'object' &&
    value !== null &&
    Object.getPrototypeOf(value) === Object.prototype
  ) {
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonicalAuditJson((value as Record<string, unknown>)[key])}`,
      )
      .join(',')}}`;
  }

  throw new Error('Audit payload must contain only finite JSON values');
};

export const auditPayloadHash = (value: unknown): string =>
  createHash('sha256').update(canonicalAuditJson(value)).digest('hex');
