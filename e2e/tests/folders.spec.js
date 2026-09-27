/**
 * The mail server's own folders against the fake mailbox: folded away until
 * asked for, read-only lists, messages read from them, attachments, forwards,
 * and putting deleted mail back in the inbox.
 */
import { test, expect } from '@playwright/test';
import { signUpWithMailbox } from './helpers.js';

const SARAH = 'Quick question about the API spec';
const INVOICE = 'Invoice #1042 from Acme Corp';

const sidebar = (page) => page.getByRole('complementary');
const inboxRow = (page, subject) => page.getByRole('main').locator('li[data-uid]', { hasText: subject });

async function openFolder(page, name) {
  const toggle = sidebar(page).getByRole('button', { name: /Server folders/ });
  if ((await toggle.getAttribute('aria-expanded')) === 'false') await toggle.click();
  await sidebar(page).getByRole('button', { name: new RegExp(`^${name}`) }).click();
  await expect(page.getByRole('main').getByRole('heading', { level: 2 })).toContainText(name);
}

const folderList = (page, name) => page.getByRole('list', { name: `Messages in ${name}` });

test('folders stay folded away until opened, and Junk can be read', async ({ page }) => {
  await signUpWithMailbox(page);
  const toggle = sidebar(page).getByRole('button', { name: /Server folders/ });
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(sidebar(page).getByRole('button', { name: /^Junk/ })).toHaveCount(0);

  await toggle.click();
  for (const name of ['Sent', 'Drafts', 'Archive', 'Trash', 'Junk']) {
    await expect(sidebar(page).getByRole('button', { name: new RegExp(`^${name}`) })).toBeVisible();
  }

  await openFolder(page, 'Junk');
  await folderList(page, 'Junk').getByRole('button', { name: /You have won a prize!/ }).click();
  await expect(page.getByRole('heading', { name: 'You have won a prize!', level: 1 })).toBeVisible();
  // Read-only: no archive, delete or star, and nothing to move back without a Message-ID.
  const article = page.getByRole('article');
  await expect(article.getByRole('button', { name: /Archive|Delete|Remember|Move to Inbox/ })).toHaveCount(0);
  await expect(article.getByRole('button', { name: 'Forward' })).toBeVisible();

  await article.getByRole('button', { name: 'Back to Junk' }).click();
  await expect(folderList(page, 'Junk')).toBeVisible();
  await page.getByRole('main').getByRole('button', { name: /Inbox/ }).click();
  await expect(inboxRow(page, 'PR #47 merged')).toBeVisible();
});

test('a deleted message is in Trash and can be moved back to the inbox', async ({ page }) => {
  await signUpWithMailbox(page);
  await inboxRow(page, SARAH).hover();
  await page.getByRole('button', { name: `Delete “${SARAH}”` }).click();
  await expect(page.getByRole('status')).toHaveText('Moved to Trash.');

  await openFolder(page, 'Trash');
  await folderList(page, 'Trash').getByRole('button', { name: new RegExp(SARAH) }).click();
  await expect(page.getByRole('heading', { name: SARAH, level: 1 })).toBeVisible();
  await page.getByRole('button', { name: 'Move to Inbox' }).click();

  await expect(page.getByRole('status')).toHaveText('Moved to the inbox.');
  await expect(page.getByText('Nothing in Trash.')).toBeVisible();
  await page.getByRole('main').getByRole('button', { name: /Inbox/ }).click();
  await expect(inboxRow(page, SARAH)).toBeVisible();
});

async function forwardTo(page, address) {
  await page.getByRole('article').getByRole('button', { name: 'Forward' }).click();
  const dialog = page.getByRole('dialog', { name: 'Forward' });
  await dialog.getByLabel('To', { exact: true }).fill(address);
  await dialog.getByRole('button', { name: 'Send' }).click();
  await expect(page.getByRole('status')).toHaveText(`Message sent to ${address}.`);
}

test('sent mail shows in Sent, and its attachments forward from there', async ({ page }) => {
  await signUpWithMailbox(page);
  // Forward the invoice, attachments and all, so Sent has files.
  await page.getByRole('textbox', { name: /Search emails/ }).fill('Invoice');
  await page.keyboard.press('Enter');
  await page.getByRole('main').getByText(INVOICE).click();
  await expect(page.getByRole('heading', { name: INVOICE, level: 1 })).toBeVisible();
  await forwardTo(page, 'books@acme.example');

  await openFolder(page, 'Sent');
  await folderList(page, 'Sent').getByRole('button', { name: new RegExp(`Fwd: ${INVOICE}`) }).click();
  const article = page.getByRole('article');
  await expect(article.getByRole('heading', { name: `Fwd: ${INVOICE}`, level: 1 })).toBeVisible();
  const attachments = article.getByRole('region', { name: 'Attachments' });
  await expect(attachments.getByRole('button')).toHaveCount(2);

  // Downloading reads it from Sent.
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    attachments.getByRole('button', { name: /^Download Receipt-1042\.pdf/ }).click(),
  ]);
  expect(download.suggestedFilename()).toBe('Receipt-1042.pdf');

  // Forwarding it again sends the same files, taken from the Sent copy.
  await forwardTo(page, 'audit@acme.example');

  const outbox = await (await page.request.get('/api/test/outbox')).json();
  const [first, second] = outbox.slice(-2);
  expect(second.to[0].email).toBe('audit@acme.example');
  expect(second.attachments).toEqual(first.attachments);
  expect(second.attachments).toHaveLength(2);

  // The open Sent folder shows the new message too.
  await article.getByRole('button', { name: 'Back to Sent' }).click();
  await expect(folderList(page, 'Sent').getByRole('button')).toHaveCount(2);
});

test('looking in a folder does not mark the inbox seen', async ({ page }) => {
  await signUpWithMailbox(page);
  const header = page.getByRole('main').getByRole('heading', { level: 2 });
  const before = await header.textContent();
  expect(before).toMatch(/new|emails/);
  await openFolder(page, 'Junk');
  await page.getByRole('main').getByRole('button', { name: /Inbox/ }).click();
  await expect(header).toHaveText(before);
});
