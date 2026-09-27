/**
 * Inbox rendering checks that need a real browser (CSS, layout, locale).
 * The API is mocked, so no IMAP account is required.
 */
import { test, expect } from '@playwright/test';

const HOUR = 3600_000;
const DAY = 24 * HOUR;
const ago = (ms) => new Date(Date.now() - ms).toISOString();

// Newest first: four emails from the last few minutes (so they are "today"),
// then one every six hours going back six days, plus one without a date.
const EMAILS = Array.from({ length: 24 }, (_, i) => ({
  uid: 300 - i,
  subject: `Message ${i}`,
  from: `Sender ${i % 5}`,
  date: ago(i < 4 ? (i + 1) * 60_000 : i * 6 * HOUR),
}));
EMAILS.push({ uid: 200, subject: 'Undated', from: 'Nobody', date: null });
const WATERMARK = 298;

async function mockApi(page, { searchResults = [] } = {}) {
  await page.route('**/api/**', (route) => {
    const path = new URL(route.request().url()).pathname;
    const json = (body) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    if (path === '/api/auth/status') {
      return json({ logged_in: true, user: { user_id: 'u', email: 'me@example.com', display_name: 'Me' } });
    }
    if (path === '/api/accounts') {
      return json([{ id: 'acct', email: 'me@example.com', connected: true, password_saved: false }]);
    }
    if (path === '/api/accounts/acct/emails') {
      return json({ emails: EMAILS, since_timestamp: Date.now() - 6 * DAY, last_open: Date.now() - DAY, watermark_uid: WATERMARK });
    }
    if (path.startsWith('/api/accounts/acct/emails/')) {
      return json({
        uid: 300,
        subject: 'Formatted',
        from: [{ name: 'Sender 0', email: 'sender0@example.com' }],
        reply_to: [],
        to: [{ name: null, email: 'me@example.com' }],
        cc: [],
        date: ago(HOUR),
        received: ago(HOUR),
        body_html: '<h1>Heading</h1><p>Read the <a href="https://example.com">docs</a>.</p><ul><li>One</li></ul>',
        body_text: null,
      });
    }
    if (path === '/api/accounts/acct/search') return json(searchResults);
    if (path === '/api/accounts/acct/remembered') return json([]);
    if (path === '/api/accounts/acct/drafts') return json([]);
    return json({ ok: true });
  });
}

async function openInbox(page) {
  await mockApi(page);
  await page.goto('/inbox');
  await expect(page.getByText('Message 0', { exact: true }).first()).toBeVisible();
}

test('HTML emails keep their formatting and visible links', async ({ page }) => {
  await openInbox(page);
  await page.locator('main').getByText('Message 0', { exact: true }).click();
  const body = page.locator('.prose');
  await expect(body.getByRole('heading', { name: 'Heading' })).toBeVisible();

  const styles = await body.evaluate((el) => ({
    h1: parseFloat(getComputedStyle(el.querySelector('h1')).fontSize),
    p: parseFloat(getComputedStyle(el.querySelector('p')).fontSize),
    list: getComputedStyle(el.querySelector('ul')).listStyleType,
    link: getComputedStyle(el.querySelector('a')).textDecorationLine,
  }));
  expect(styles.h1).toBeGreaterThan(styles.p);
  expect(styles.list).toBe('disc');
  expect(styles.link).toContain('underline');
});

test('every email appears in the sidebar in a non-English locale', async ({ browser }) => {
  const context = await browser.newContext({ locale: 'fr-FR' });
  const page = await context.newPage();
  await openInbox(page);
  const counts = await page.locator('aside nav button[aria-expanded]').evaluateAll((buttons) =>
    buttons
      .filter((b) => !b.textContent.startsWith('Mailboxes'))
      .map((b) => Number(b.textContent.match(/(\d+) emails?$/)?.[1] ?? 0)),
  );
  expect(counts.reduce((a, b) => a + b, 0)).toBe(EMAILS.length);
  await context.close();
});

test('seen rows are greyed out in both light and dark mode', async ({ browser }) => {
  for (const colorScheme of ['light', 'dark']) {
    const context = await browser.newContext({ colorScheme });
    const page = await context.newPage();
    await openInbox(page);
    const [unseen, seen] = await Promise.all(
      [`[data-uid="${WATERMARK + 1}"]`, `[data-uid="${WATERMARK - 1}"]`].map((selector) =>
        page.locator(selector).evaluate((row) => ({
          background: getComputedStyle(row).backgroundColor,
          text: getComputedStyle(row.querySelector('button span span')).color,
        })),
      ),
    );
    expect(seen.background, colorScheme).not.toBe(unseen.background);
    expect(seen.text, colorScheme).not.toBe(unseen.text);
    await context.close();
  }
});

test.describe('on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  test('the drawer fits the screen and stays open while browsing days', async ({ page }) => {
    await openInbox(page);
    await page.getByRole('button', { name: 'Open sidebar' }).click();
    const sidebar = page.getByRole('complementary');
    await sidebar.getByRole('button', { name: /Yesterday/ }).click();

    const box = await sidebar.boundingBox();
    expect(box.x).toBeGreaterThanOrEqual(0);
    const navBottom = await sidebar.locator('nav').evaluate((nav) => nav.getBoundingClientRect().bottom);
    expect(navBottom).toBeLessThanOrEqual(844);

    await page.keyboard.press('Escape');
    await expect(page.getByRole('button', { name: 'Open sidebar' })).toBeFocused();
  });

  test('row actions are large enough to tap', async ({ page }) => {
    await openInbox(page);
    const star = page.getByRole('button', { name: 'Remember “Message 0”' });
    const box = await star.boundingBox();
    expect(box.width).toBeGreaterThanOrEqual(32);
    expect(box.height).toBeGreaterThanOrEqual(32);
  });
});

test('an empty search explains itself', async ({ page }) => {
  await openInbox(page);
  await page.getByRole('textbox', { name: /Search emails/ }).fill('zebra');
  await page.keyboard.press('Enter');
  await expect(page.getByText('No emails match “zebra”')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Refresh' })).toHaveCount(0);
});
