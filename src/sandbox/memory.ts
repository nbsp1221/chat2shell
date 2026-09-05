const MEBIBYTE = 1024 * 1024;
const GIBIBYTE = 1024 * MEBIBYTE;

export function parseMemory(value: string): number {
  const match = /^([1-9]\d*)(m|g)$/.exec(value);
  if (!match) {
    throw new Error('memory must use positive binary megabytes or gigabytes, such as 512m or 4g');
  }
  const amount = Number(match[1]);
  const bytes = amount * (match[2] === 'g' ? GIBIBYTE : MEBIBYTE);
  if (!Number.isSafeInteger(bytes)) {
    throw new Error('memory is too large');
  }
  return bytes;
}

export function formatMemory(bytes: number): string {
  return bytes % GIBIBYTE === 0 ? `${bytes / GIBIBYTE}g` : `${bytes / MEBIBYTE}m`;
}
