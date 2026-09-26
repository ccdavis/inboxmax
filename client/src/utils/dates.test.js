import { describe, expect, it } from 'vitest';
import { calendarDaysAgo, formatTime, groupByDay, isToday } from './dates';

// Saturday 26 Sep 2026, 09:00 local time.
const NOW = new Date(2026, 8, 26, 9, 0);
const at = (day, hour = 12) => new Date(2026, 8, day, hour, 0).toISOString();
const summarize = (groups) => groups.map((g) => [g.label, g.emails.map((e) => e.uid)]);

describe('calendarDaysAgo', () => {
  it('counts calendar days, not 24-hour periods', () => {
    expect(calendarDaysAgo(new Date(2026, 8, 25, 23, 59), NOW)).toBe(1);
    expect(calendarDaysAgo(new Date(2026, 8, 26, 0, 1), NOW)).toBe(0);
    expect(calendarDaysAgo(new Date(2026, 8, 27, 8, 0), NOW)).toBe(-1);
  });
});

describe('groupByDay', () => {
  it('orders Today, Yesterday, weekdays, Older, Unknown and keeps every email', () => {
    const emails = [
      { uid: 1, date: at(26, 8) },
      { uid: 2, date: at(25) },
      { uid: 3, date: at(23) },
      { uid: 4, date: at(10) },
      { uid: 5, date: null },
      { uid: 6, date: at(21) },
    ];
    expect(summarize(groupByDay(emails, { now: NOW, locale: 'en-US' }))).toEqual([
      ['Today', [1]],
      ['Yesterday', [2]],
      ['Wednesday', [3]],
      ['Monday', [6]],
      ['Older', [4]],
      ['Unknown', [5]],
    ]);
  });

  it('keeps an email from later in the day exactly a week ago', () => {
    // Saturday 19 Sep at 18:00 is under seven 24-hour days before NOW but is
    // seven calendar days back, so it belongs in Older rather than vanishing.
    const groups = groupByDay([{ uid: 1, date: at(19, 18) }], { now: NOW, locale: 'en-US' });
    expect(summarize(groups)).toEqual([['Older', [1]]]);
  });

  it('keeps every email when weekday names are localized', () => {
    const emails = [20, 21, 22, 23, 24].map((day) => ({ uid: day, date: at(day) }));
    const groups = groupByDay(emails, { now: NOW, locale: 'fr-FR' });
    expect(groups.flatMap((g) => g.emails)).toHaveLength(emails.length);
    expect(groups.map((g) => g.label)).toEqual(['jeudi', 'mercredi', 'mardi', 'lundi', 'dimanche']);
  });

  it('files future-dated emails under Today and omits empty groups', () => {
    const groups = groupByDay([{ uid: 1, date: at(27) }], { now: NOW });
    expect(summarize(groups)).toEqual([['Today', [1]]]);
    expect(groupByDay([], { now: NOW })).toEqual([]);
  });

  it('treats unparseable dates as Unknown', () => {
    expect(summarize(groupByDay([{ uid: 1, date: 'not a date' }], { now: NOW }))).toEqual([['Unknown', [1]]]);
  });
});

describe('isToday and formatTime', () => {
  it('handle today, yesterday, and older dates', () => {
    expect(isToday(at(26, 1), NOW)).toBe(true);
    expect(isToday(at(25), NOW)).toBe(false);
    expect(isToday(null, NOW)).toBe(false);
    expect(formatTime(at(25), { now: NOW })).toBe('Yesterday');
    expect(formatTime(at(3), { now: NOW, locale: 'en-US' })).toBe('Sep 3');
    expect(formatTime(null)).toBe('');
  });
});
