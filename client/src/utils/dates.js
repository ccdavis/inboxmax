const DAY_MS = 24 * 60 * 60 * 1000;

function startOfDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

/**
 * Whole calendar days from `date` back to `now` in local time: 0 is today,
 * 1 is yesterday. Rounding absorbs daylight-saving shifts; future dates
 * (sender clock skew) give negative values.
 */
export function calendarDaysAgo(date, now = new Date()) {
  return Math.round((startOfDay(now) - startOfDay(date)) / DAY_MS);
}

export function isToday(dateStr, now = new Date()) {
  return Boolean(dateStr) && calendarDaysAgo(new Date(dateStr), now) <= 0;
}

export function formatTime(dateStr, { now = new Date(), locale } = {}) {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  const daysAgo = calendarDaysAgo(d, now);
  if (daysAgo <= 0) {
    return d.toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit' });
  }
  if (daysAgo === 1) return 'Yesterday';
  return d.toLocaleDateString(locale, { month: 'short', day: 'numeric' });
}

export function formatFullDate(dateStr, { locale } = {}) {
  if (!dateStr) return '';
  return new Date(dateStr).toLocaleString(locale, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

/**
 * Group emails into Today, Yesterday, the five weekdays before that, Older,
 * and Unknown (no parseable date), newest group first. Groups are keyed by
 * calendar-day offset, so localized weekday labels never affect membership.
 * Empty groups are omitted.
 */
export function groupByDay(emails, { now = new Date(), locale } = {}) {
  const groups = new Map();
  const add = (key, label, email) => {
    if (!groups.has(key)) groups.set(key, { key, label, emails: [] });
    groups.get(key).emails.push(email);
  };

  for (const email of emails) {
    const d = email.date ? new Date(email.date) : null;
    if (!d || Number.isNaN(d.getTime())) {
      add('unknown', 'Unknown', email);
      continue;
    }
    const daysAgo = Math.max(0, calendarDaysAgo(d, now));
    if (daysAgo === 0) add('day-0', 'Today', email);
    else if (daysAgo === 1) add('day-1', 'Yesterday', email);
    else if (daysAgo < 7) {
      add(`day-${daysAgo}`, d.toLocaleDateString(locale, { weekday: 'long' }), email);
    } else add('older', 'Older', email);
  }

  const order = ['day-0', 'day-1', 'day-2', 'day-3', 'day-4', 'day-5', 'day-6', 'older', 'unknown'];
  return order.filter((key) => groups.has(key)).map((key) => groups.get(key));
}
