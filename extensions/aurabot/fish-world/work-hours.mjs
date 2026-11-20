// Automatic background work only. Empty preserves the existing schedule.
// Times are Beijing wall time; ranges may cross midnight and are end-exclusive.
export function workHoursAllowed(value, now = Date.now()) {
  if (value == null || value === '') return true;
  if (typeof value !== 'string' || value.length > 200) return false;
  const ranges = value.split(/[,，]/).map(x => x.trim());
  if (!ranges.length || ranges.length > 8 || ranges.some(x => !x)) return false;
  const intervals = [];
  for (const range of ranges) {
    const m = /^(\d{1,2}):(\d{2})\s*[-–~]\s*(\d{1,2}):(\d{2})$/.exec(range);
    if (!m) return false;
    const [a,b,c,d] = m.slice(1).map(Number);
    if (a > 23 || b > 59 || c > 23 || d > 59) return false;
    intervals.push([a * 60 + b,c * 60 + d]);
  }
  const timestamp = Number(now instanceof Date ? now.getTime() : now);
  if (!Number.isFinite(timestamp)) return false;
  const t = new Date(timestamp + 8 * 3600000);
  const minute = t.getUTCHours() * 60 + t.getUTCMinutes();
  return intervals.some(([start,end]) => start === end || (start < end ? minute >= start && minute < end : minute >= start || minute < end));
}
