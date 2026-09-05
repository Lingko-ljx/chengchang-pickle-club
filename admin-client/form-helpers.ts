export function schedulingEndOptions(start: string, current: string, duration: 30 | 60) {
  const times = Array.from({ length: 27 }, (_, index) => {
    const minutes = 540 + index * 30;
    return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
  });
  const startIndex = times.indexOf(start);
  if (startIndex < 0 || startIndex === times.length - 1) return { options: [], selected: "" };
  const options = times.slice(startIndex + 1);
  const fallback = options[Math.min(duration / 30 - 1, options.length - 1)];
  return { options, selected: options.includes(current) ? current : fallback };
}

export function nextHonorSortOrder(items: { sortOrder: number }[]): number {
  return Math.min(9999, Math.max(0, ...items.map((item) => Number.isFinite(item.sortOrder) ? item.sortOrder : 0)) + 1);
}
