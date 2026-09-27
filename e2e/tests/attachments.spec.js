/**
 * Attachments against the fake mailbox: listing and downloading them (the
 * browser saves the real file), attaching files when composing, and
 * forwarding a message's attachments.
 */
import { readFile } from 'node:fs/promises';
import { test, expect } from '@playwright/test';
import { signUpWithMailbox } from './helpers.js';

async function open(page, subject) {
  await page.getByRole('main').getByText(subject).click();
  await expect(page.getByRole('heading', { name: subject, level: 1 })).toBeVisible();
}

async function search(page, text) {
  await page.getByRole('textbox', { name: /Search emails/ }).fill(text);
  await page.keyboard.press('Enter');
}

async function download(page, name) {
  const [file] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: new RegExp(`^Download ${name}`) }).click(),
  ]);
  return { name: file.suggestedFilename(), contents: await readFile(await file.path(), 'utf8') };
}

async function lastSent(page) {
  return (await (await page.request.get('/api/test/outbox')).json()).at(-1);
}

test('attachments are listed and download as the real file', async ({ page }) => {
  await signUpWithMailbox(page);
  await open(page, 'Quick question about the API spec');
  const list = page.getByRole('region', { name: 'Attachments' });
  await expect(list).toContainText('API spec v2 (draft).txt');
  await expect(list).toContainText('46 B');

  const file = await download(page, 'API spec v2');
  expect(file.name).toBe('API spec v2 (draft).txt');
  expect(file.contents).toBe('PATCH /v2/items/{id} accepts partial updates.\n');

  // A name built to escape the download folder arrives flattened.
  await page.getByRole('button', { name: 'Back to inbox' }).click();
  await open(page, 'Team standup notes');
  const notes = await download(page, '_');
  expect(notes.name).not.toMatch(/[\\/]/);
  expect(notes.name).toContain('standup notes.md');
  expect(notes.contents).toContain('Shipped the dashboard fix');
});

test('files attached while composing are sent', async ({ page }) => {
  await signUpWithMailbox(page);
  await page.getByRole('button', { name: /Compose/ }).click();
  const dialog = page.getByRole('dialog', { name: 'New message' });
  await dialog.getByLabel('To', { exact: true }).fill('a@acme.example');
  await dialog.getByLabel('Subject').fill('Report');
  await dialog.getByLabel('Attach files').setInputFiles([
    { name: 'report.csv', mimeType: 'text/csv', buffer: Buffer.from('month,total\nMay,42\n') },
    { name: 'Grüße.txt', mimeType: 'text/plain', buffer: Buffer.from('Hallo') },
  ]);
  const attached = dialog.getByRole('list', { name: 'Attachments' });
  await expect(attached.getByRole('listitem')).toHaveCount(2);
  await expect(attached).toContainText('report.csv');

  await dialog.getByRole('button', { name: 'Send' }).click();
  await expect(page.getByRole('status')).toHaveText('Message sent to a@acme.example.');
  // What the recipient's mail client decodes from the message as sent.
  const sent = await lastSent(page);
  expect(sent.raw).toContain('Content-Type: multipart/mixed');
  expect(sent.attachments.map(({ filename, content_type, data }) => [
    filename, content_type, Buffer.from(data, 'base64').toString(),
  ])).toEqual([
    ['report.csv', 'text/csv; charset=utf-8', 'month,total\nMay,42\n'],
    ['Grüße.txt', 'text/plain; charset=utf-8', 'Hallo'],
  ]);
});

test('a forward sends the original attachments that are kept', async ({ page }) => {
  await signUpWithMailbox(page);
  await search(page, 'Invoice');
  await open(page, 'Invoice #1042 from Acme Corp');
  await page.getByRole('button', { name: 'Forward' }).click();

  const dialog = page.getByRole('dialog', { name: 'Forward' });
  const attached = dialog.getByRole('list', { name: 'Attachments' });
  await expect(attached.getByRole('listitem')).toHaveText([/Invoice-1042\.pdf/, /Receipt-1042\.pdf/]);
  await dialog.getByRole('button', { name: 'Remove attachment Invoice-1042.pdf' }).click();
  await dialog.getByLabel('To', { exact: true }).fill('accounts@acme.example');
  await dialog.getByRole('button', { name: 'Send' }).click();
  await expect(page.getByRole('status')).toHaveText('Message sent to accounts@acme.example.');

  const sent = await lastSent(page);
  expect(sent.attachments.map(({ filename, content_type, data }) => [
    filename, content_type, Buffer.from(data, 'base64').toString(),
  ])).toEqual([
    ['Receipt-1042.pdf', 'application/pdf', '%PDF-1.4\n% Inbox Max demo receipt\n%%EOF\n'],
  ]);
});

test('attachments over 25 MB in all are refused before sending', async ({ page }) => {
  await signUpWithMailbox(page);
  await page.getByRole('button', { name: /Compose/ }).click();
  const dialog = page.getByRole('dialog', { name: 'New message' });
  await dialog.getByLabel('Attach files').setInputFiles({
    name: 'huge.bin',
    mimeType: 'application/octet-stream',
    buffer: Buffer.alloc(26 * 1024 * 1024),
  });
  await expect(dialog.getByRole('alert')).toHaveText('Attachments can total at most 25 MB');
  await expect(dialog.getByRole('list', { name: 'Attachments' })).toHaveCount(0);
});
