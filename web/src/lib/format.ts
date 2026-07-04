export function formatTimestamp(value: string | null | undefined): string {
  if (!value) {
    return "—";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return date.toLocaleString();
}

export function truncateId(value: string, length = 8): string {
  if (value.length <= length) {
    return value;
  }
  return `${value.slice(0, length)}…`;
}
