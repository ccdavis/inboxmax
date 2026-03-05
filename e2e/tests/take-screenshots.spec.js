/**
 * Takes screenshots for the README.
 *
 * Usage:
 *   cd e2e && npx playwright test take-screenshots.js
 *
 * The inbox screenshot uses mocked API responses so it works
 * without real IMAP credentials — just a running server.
 */
import { test } from '@playwright/test';

// ---------------------------------------------------------------------------
// Mock data for the inbox screenshot
// ---------------------------------------------------------------------------

function hoursAgo(h) {
  return new Date(Date.now() - h * 3600_000).toISOString();
}

const WATERMARK_UID = 204;

const MOCK_EMAILS = [
  { uid: 208, subject: 'PR #47 merged: fix dashboard layout', from: 'GitHub', date: hoursAgo(0.1), has_attachment: false },
  { uid: 207, subject: 'Your AWS billing summary for March', from: 'Amazon Web Services', date: hoursAgo(0.5), has_attachment: true },
  { uid: 206, subject: 'Quick question about the API spec', from: 'Sarah Chen', date: hoursAgo(1.2), has_attachment: false },
  { uid: 205, subject: 'Team standup notes - March 4', from: 'Notion', date: hoursAgo(2), has_attachment: false },
  { uid: 204, subject: 'Invitation: Design review @ Wed 2pm', from: 'Google Calendar', date: hoursAgo(3.5), has_attachment: false },
  { uid: 203, subject: 'Your order has shipped!', from: 'Amazon', date: hoursAgo(5), has_attachment: false },
  { uid: 202, subject: 'New sign-in from Chrome on Linux', from: 'Google', date: hoursAgo(7), has_attachment: false },
  { uid: 201, subject: 'Invoice #1042 from Acme Corp', from: 'Stripe', date: hoursAgo(9), has_attachment: true },
];

const MOCK_REMEMBERED = [
  { id: 1, email_uid: 195, subject: 'Flight confirmation - SFO to JFK', sender: 'Delta Airlines', date: Date.now() - 86400_000 * 3, added_at: Date.now() - 86400_000 },
  { id: 2, email_uid: 180, subject: 'Apartment lease renewal docs', sender: 'Property Mgmt', date: Date.now() - 86400_000 * 7, added_at: Date.now() - 86400_000 * 2 },
];

const STATUS_RESPONSE = {
  logged_in: true,
  email: 'demo@inboxmax.app',
  user: { user_id: 'demo-user', email: 'demo@inboxmax.app', display_name: 'Demo User' },
  imap_connected: true,
  imap_email: 'demo@inboxmax.app',
};

const EMAILS_RESPONSE = {
  emails: MOCK_EMAILS,
  since_timestamp: Date.now() - 24 * 3600_000,
  last_open: Date.now() - 12 * 3600_000,
  watermark_uid: WATERMARK_UID,
};

// ---------------------------------------------------------------------------
// Screenshots
// ---------------------------------------------------------------------------

test('landing page screenshot', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/');
  // Wait for the hero content to render
  await page.locator('h1').waitFor();
  // Small delay for fonts/images
  await page.waitForTimeout(500);
  await page.screenshot({ path: '../docs/landing.png', fullPage: true });
});

test('inbox screenshot with seen and unseen emails', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });

  // Mock all API calls so we get a realistic inbox without real IMAP
  await page.route('**/api/auth/status', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(STATUS_RESPONSE) })
  );
  await page.route('**/api/emails', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(EMAILS_RESPONSE) })
  );
  await page.route('**/api/remembered', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(MOCK_REMEMBERED) })
  );
  // Catch watermark PUTs so they don't 401
  await page.route('**/api/watermark', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' })
  );

  await page.goto('/inbox');

  // Wait for emails to render
  await page.locator('text=PR #47 merged').waitFor({ timeout: 5000 });
  await page.waitForTimeout(500);

  await page.screenshot({ path: '../docs/inbox.png' });
});
