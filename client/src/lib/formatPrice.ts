export function formatPrice(value: number | null | undefined, digits = 12): string {
  if (value == null || !Number.isFinite(Number(value))) return '—';
  return new Intl.NumberFormat('en-US', {
    useGrouping: false,
    maximumSignificantDigits: digits
  }).format(Number(value));
}
