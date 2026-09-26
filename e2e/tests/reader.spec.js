/**
 * The reader's headers against the generated demo mailbox: every address in
 * full, where replies go, Cc, and when a message was received and sent.
 */
import { test, expect } from '@playwright/test';
import { headerRow, signUpWithMailbox } from './helpers.js';

async function open(page, subject) {
  await page.getByRole('main').getByText(subject).click();
  await expect(page.getByRole('heading', { name: subject, level: 1 })).toBeVisible();
}

async function back(page) {
  await page.getByRole('button', { name: 'Back to inbox' }).click();
}

test('shows full addresses, Reply-To, Cc, and when each message arrived', async ({ page }) => {
  const me = await signUpWithMailbox(page);

  // A Reply-To that differs from the sender is shown and flagged.
  await open(page, 'PR #47 merged: fix dashboard layout');
  await expect(headerRow(page, 'From')).toHaveText('GitHub (acme.example) <notifications@github.com>');
  await expect(headerRow(page, 'Reply-To')).toContainText('ccdavis/inboxmax <reply+a1b2c3@reply.github.com>');
  await expect(headerRow(page, 'Reply-To')).toContainText('Replies go here, not to the sender.');
  await expect(headerRow(page, 'To')).toHaveText(me);
  await expect(page.getByRole('article').locator('dt', { hasText: /^Cc$/ })).toHaveCount(0);
  // Delivered at once: the received time only.
  await expect(headerRow(page, 'Received').locator('time')).toHaveAttribute('datetime', /\d{4}-\d\d-\d\dT/);
  await expect(page.getByRole('article').locator('dt', { hasText: /^Sent$/ })).toHaveCount(0);
  await back(page);

  // Cc, and no Reply-To row when the message has none.
  await open(page, 'Quick question about the API spec');
  await expect(headerRow(page, 'From')).toHaveText('Sarah Chen (acme.example) <sarah.chen@acme.example>');
  await expect(headerRow(page, 'Cc')).toHaveText('Bob Park <bob.park@acme.example>');
  await expect(page.getByRole('article').locator('dt', { hasText: /^Reply-To$/ })).toHaveCount(0);
  await back(page);

  // Replies to a calendar invitation go to a person, not the robot that sent it.
  await open(page, 'Invitation: Design review @ Wed 2pm');
  await expect(headerRow(page, 'Reply-To')).toContainText('Sarah Chen <sarah.chen@acme.example>');
  await back(page);
});

test('a delayed delivery shows both the received and the sent time', async ({ page }) => {
  await signUpWithMailbox(page);
  // Older than the first visit's window, so reach it through search.
  await page.getByRole('textbox', { name: /Search emails/ }).fill('Flight');
  await page.keyboard.press('Enter');
  await open(page, 'Flight confirmation - SFO to JFK');

  const received = await headerRow(page, 'Received').locator('time').getAttribute('datetime');
  const sent = await headerRow(page, 'Sent').locator('time').getAttribute('datetime');
  expect(new Date(received) - new Date(sent)).toBe(180 * 60 * 1000);
  await expect(headerRow(page, 'Sent')).toContainText('by the sender’s clock');
});
