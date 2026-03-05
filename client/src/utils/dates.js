export function formatTime(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  const now = new Date();
  const isToday = d.toDateString() === now.toDateString();
  if (isToday) {
    return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) {
    return 'Yesterday';
  }
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

export function formatFullDate(dateStr) {
  if (!dateStr) return '';
  return new Date(dateStr).toLocaleString([], {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

export function groupByDay(emails) {
  const groups = {};
  const now = new Date();

  for (const email of emails) {
    const d = email.date ? new Date(email.date) : null;
    let label;
    if (!d) {
      label = 'Unknown';
    } else if (d.toDateString() === now.toDateString()) {
      label = 'Today';
    } else {
      const yesterday = new Date(now);
      yesterday.setDate(yesterday.getDate() - 1);
      if (d.toDateString() === yesterday.toDateString()) {
        label = 'Yesterday';
      } else {
        const diffDays = Math.floor((now - d) / (1000 * 60 * 60 * 24));
        if (diffDays < 7) {
          label = d.toLocaleDateString([], { weekday: 'long' });
        } else {
          label = 'Older';
        }
      }
    }
    if (!groups[label]) groups[label] = [];
    groups[label].push(email);
  }

  // Always include Today even if empty
  if (!groups['Today']) groups['Today'] = [];

  // Order: Today, Yesterday, weekday names, Older
  const dayOrder = ['Today', 'Yesterday'];
  const weekdays = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const todayIdx = now.getDay();
  // Add weekdays in reverse order from 2 days ago
  for (let i = 2; i < 7; i++) {
    const idx = (todayIdx - i + 7) % 7;
    dayOrder.push(weekdays[idx]);
  }
  dayOrder.push('Older', 'Unknown');

  const ordered = [];
  for (const label of dayOrder) {
    if (groups[label]) {
      ordered.push({ label, emails: groups[label] });
    }
  }
  return ordered;
}

export function relativeTime(ms) {
  if (!ms) return '';
  const now = Date.now();
  const diff = now - ms;
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
