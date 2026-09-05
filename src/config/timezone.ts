process.env.TZ = 'America/Bogota';

export const DEFAULT_TIMEZONE = 'America/Bogota';

export const BOGOTA_UTC_OFFSET_MS = -5 * 60 * 60 * 1000;

export function fromBogotaWallClock(localDateTime: string): Date {
  const match = /^(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2})(?::(\d{2}))?/.exec(
    localDateTime,
  );
  const normalized = match ? `${match[1]}:${match[2] ?? '00'}` : localDateTime;
  const asUtc = new Date(`${normalized}Z`);
  if (Number.isNaN(asUtc.getTime())) {
    throw new Error(`Fecha/hora local inválida: ${localDateTime}`);
  }
  return new Date(asUtc.getTime() - BOGOTA_UTC_OFFSET_MS);
}
