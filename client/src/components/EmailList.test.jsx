import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import EmailList from './EmailList';

const HOUR = 3600_000;
const hoursAgo = (h) => new Date(Date.now() - h * HOUR).toISOString();
const daysAgo = (d) => new Date(Date.now() - d * 24 * HOUR).toISOString();

// uid 5..3 are today (whatever the time of day, "0 hours ago" is today),
// 2 is an unseen email from two days ago, 1 is a seen email from two days ago.
const EMAILS = [
  { uid: 5, subject: 'Newest', from: 'Ann', date: hoursAgo(0) },
  { uid: 4, subject: 'Marker', from: 'Bob', date: hoursAgo(0) },
  { uid: 3, subject: 'Seen today', from: 'Cy', date: hoursAgo(0) },
  { uid: 6, subject: 'Unseen from earlier', from: 'Di', date: daysAgo(2) },
  { uid: 1, subject: 'Seen long ago', from: 'Ed', date: daysAgo(2) },
];

function renderList(props = {}) {
  const handlers = {
    onSelectEmail: vi.fn(),
    onToggleRemember: vi.fn(),
    onSetWatermark: vi.fn(),
    onToggleHideSeen: vi.fn(),
    onRefresh: vi.fn(),
  };
  render(
    <EmailList
      emails={EMAILS}
      loading={false}
      refreshing={false}
      error={null}
      lastOpen={Date.now() - HOUR}
      isRemembered={() => false}
      searchQuery={null}
      watermarkUid={4}
      hideSeen={false}
      {...handlers}
      {...props}
    />,
  );
  return handlers;
}

const rowFor = (subject) => screen.getByText(subject).closest('li');

describe('EmailList', () => {
  afterEach(cleanup);

  it('shows unseen emails from any day plus the rest of today', () => {
    renderList();
    const subjects = screen.getAllByRole('listitem')
      .map((li) => EMAILS.find((email) => li.textContent.includes(email.subject)).subject);
    expect(subjects).toEqual(['Newest', 'Marker', 'Seen today', 'Unseen from earlier']);
    expect(screen.getByRole('heading', { name: '2 new' })).toBeInTheDocument();
    expect(screen.getByText(/1 earlier email you've already seen/)).toBeInTheDocument();
  });

  it('highlights the marker row as the line and greys out everything below it', () => {
    renderList();
    expect(rowFor('Newest').className).toContain('bg-canvas');
    expect(rowFor('Marker').className).toContain('bg-marker-row');
    expect(within(rowFor('Marker')).getByLabelText('Last seen marker')).toBeInTheDocument();
    expect(rowFor('Seen today').className).toContain('bg-seen');
    // The highlighted row is the line, so no separate divider.
    expect(screen.queryByRole('separator')).toBeNull();
  });

  it('keeps the marker row in view when it is from an earlier day', () => {
    const emails = [
      { uid: 9, subject: 'New today', from: 'Ann', date: hoursAgo(0) },
      { uid: 8, subject: 'Seen yesterday', from: 'Bob', date: daysAgo(1.5) },
      { uid: 7, subject: 'Seen before that', from: 'Cy', date: daysAgo(2) },
    ];
    renderList({ emails, watermarkUid: 8 });
    expect(rowFor('Seen yesterday').className).toContain('bg-marker-row');
    expect(screen.queryByText('Seen before that')).toBeNull();
  });

  it('draws a divider where the marker would be when its email is not listed', () => {
    const emails = [
      { uid: 9, subject: 'New today', from: 'Ann', date: hoursAgo(0) },
      { uid: 7, subject: 'Seen today', from: 'Cy', date: hoursAgo(0) },
    ];
    renderList({ emails, watermarkUid: 8 });
    const items = [...screen.getByRole('list').children];
    const divider = screen.getByRole('separator', { name: /Already seen/ });
    expect(items.indexOf(divider)).toBe(items.indexOf(rowFor('Seen today')) - 1);
  });

  it('shows everything as new when there is no marker yet', () => {
    renderList({ watermarkUid: null, lastOpen: null });
    expect(screen.getAllByRole('listitem')).toHaveLength(EMAILS.length);
    expect(screen.getByRole('heading', { name: '5 emails' })).toBeInTheDocument();
    expect(screen.queryByRole('separator')).toBeNull();
  });

  it('marks everything seen from the header', () => {
    const { onSetWatermark } = renderList();
    fireEvent.click(screen.getByRole('button', { name: 'Mark all seen' }));
    expect(onSetWatermark).toHaveBeenCalledWith(6);
  });

  it('offers no mark-all-seen when nothing is new', () => {
    renderList({ watermarkUid: 6 });
    expect(screen.getByRole('heading', { name: 'No new emails' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Mark all seen' })).toBeNull();
  });

  it('hides seen rows but keeps the marker when asked', () => {
    renderList({ hideSeen: true });
    expect(screen.queryByText('Seen today')).toBeNull();
    expect(screen.getByText('Marker')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Hide seen' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('says so when a search finds nothing, without mentioning refresh', () => {
    renderList({ emails: [], searchQuery: 'zebra' });
    expect(screen.getByRole('heading', { name: '0 results for “zebra”' })).toBeInTheDocument();
    expect(screen.getByText('No emails match “zebra”')).toBeInTheDocument();
    expect(screen.queryByText(/refresh/i)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Refresh' })).toBeNull();
  });

  it('reports an empty inbox', () => {
    renderList({ emails: [] });
    expect(screen.getByRole('heading', { name: 'No new emails' })).toBeInTheDocument();
    expect(screen.getByText(/We check every 2 minutes/)).toBeInTheDocument();
  });

  it('opens an email from a keyboard-accessible row button', () => {
    const { onSelectEmail } = renderList();
    fireEvent.click(within(rowFor('Newest')).getAllByRole('button')[0]);
    expect(onSelectEmail).toHaveBeenCalledWith(EMAILS[0]);
  });

  it('moves the marker with the arrow keys', () => {
    const { onSetWatermark } = renderList();
    const list = screen.getByLabelText(/arrow keys move the last-seen marker/);
    fireEvent.keyDown(list, { key: 'ArrowDown' });
    expect(onSetWatermark).toHaveBeenLastCalledWith(3);
    fireEvent.keyDown(list, { key: 'ArrowUp' });
    expect(onSetWatermark).toHaveBeenLastCalledWith(5);
  });

  it('labels row actions for assistive technology', () => {
    const { onToggleRemember, onSetWatermark } = renderList();
    fireEvent.click(screen.getByRole('button', { name: 'Remember “Newest”' }));
    expect(onToggleRemember).toHaveBeenCalledWith(EMAILS[0]);
    fireEvent.click(screen.getByRole('button', { name: 'Mark “Newest” as the last one seen' }));
    expect(onSetWatermark).toHaveBeenCalledWith(5);
  });
});
