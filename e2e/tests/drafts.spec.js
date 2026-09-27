/**
 * Drafts against the fake-mail server: closing keeps a message, it survives
 * reloads, reopens as it was, sends, and can be discarded.
 */
import { test, expect } from '@playwright/test';
import { signUpWithMailbox } from './helpers.js';

function draftsSection(page) {
  return page.getByRole('complementary').getByRole('button', { name: /^Drafts/ });
}

async function lastSent(page) {
  return (await (await page.request.get('/api/test/outbox')).json()).at(-1);
}

test('a closed message is kept as a draft, survives a reload, and sends from where it was left', async ({ page }) => {
  await signUpWithMailbox(page);
  await page.getByRole('button', { name: /Compose/ }).click();
  let dialog = page.getByRole('dialog', { name: 'New message' });
  await dialog.getByLabel('To', { exact: true }).fill('Sarah Chen <sarah.chen@acme.example>');
  await dialog.getByLabel('To', { exact: true }).press('Enter');
  await dialog.getByLabel('Subject').fill('Plans');
  await dialog.getByLabel('Message').fill('First thoughts');
  await dialog.getByLabel('Attach files').setInputFiles({ name: 'plan.txt', mimeType: 'text/plain', buffer: Buffer.from('step 1') });
  await expect(dialog.getByRole('list', { name: 'Attachments' })).toContainText('plan.txt');
  await page.keyboard.press('Escape');

  await expect(page.getByRole('status')).toHaveText('Draft saved.');
  await expect(dialog).toBeHidden();
  await page.reload();
  const draft = page.getByRole('button', { name: 'Sarah Chen: Plans' });
  await expect(draft).toBeVisible();

  await draft.click();
  dialog = page.getByRole('dialog', { name: 'New message' });
  await expect(dialog.getByRole('list', { name: 'To recipients' })).toContainText('Sarah Chen <sarah.chen@acme.example>');
  await expect(dialog.getByLabel('Message')).toHaveValue('First thoughts');
  await expect(dialog.getByRole('list', { name: 'Attachments' })).toContainText('plan.txt');
  await dialog.getByLabel('Message').fill('Final version');
  await dialog.getByRole('button', { name: 'Send' }).click();

  await expect(page.getByRole('status')).toHaveText('Message sent to Sarah Chen.');
  await expect(draftsSection(page)).toHaveCount(0);
  const sent = await lastSent(page);
  expect(sent.body).toBe('Final version');
  expect(sent.attachments.map((a) => a.filename)).toEqual(['plan.txt']);
});

test('autosave keeps a message even if the page goes away mid-sentence', async ({ page }) => {
  await signUpWithMailbox(page);
  await page.getByRole('button', { name: /Compose/ }).click();
  const dialog = page.getByRole('dialog', { name: 'New message' });
  await dialog.getByLabel('Subject').fill('Unsent thought');
  await expect(dialog.getByText('Draft saved')).toBeVisible();
  await page.reload();
  await expect(page.getByRole('button', { name: 'No recipients: Unsent thought' })).toBeVisible();
});

test('discarding a draft asks, then deletes it', async ({ page }) => {
  await signUpWithMailbox(page);
  await page.getByRole('button', { name: /Compose/ }).click();
  let dialog = page.getByRole('dialog', { name: 'New message' });
  await dialog.getByLabel('Subject').fill('Never mind');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'No recipients: Never mind' }).click();

  dialog = page.getByRole('dialog', { name: 'New message' });
  await dialog.getByRole('button', { name: 'Discard' }).click();
  const question = dialog.getByRole('group', { name: 'Discard this message?' });
  await expect(question).toContainText('Discard this message and delete its draft?');
  await question.getByRole('button', { name: 'Discard' }).click();
  await expect(dialog).toBeHidden();
  await expect(draftsSection(page)).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole('main').getByText('PR #47 merged: fix dashboard layout')).toBeVisible();
  await expect(draftsSection(page)).toHaveCount(0);
});

test('a reply kept as a draft still threads when finally sent', async ({ page }) => {
  await signUpWithMailbox(page);
  await page.getByRole('main').getByText('Quick question about the API spec').click();
  await page.getByRole('button', { name: 'Reply', exact: true }).click();
  let dialog = page.getByRole('dialog', { name: 'Reply' });
  await page.keyboard.type('Let me check.');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('status')).toHaveText('Draft saved.');

  await page.getByRole('button', { name: /^Sarah Chen \(acme\.example\): Re: Quick question/ }).click();
  dialog = page.getByRole('dialog', { name: 'Reply' });
  await expect(dialog.getByLabel('Message')).toHaveValue(/^Let me check\./);
  await dialog.getByRole('button', { name: 'Send' }).click();
  await expect(page.getByRole('status')).toContainText('Message sent to');
  const sent = await lastSent(page);
  expect(sent.raw).toContain('In-Reply-To: <998.1@fake.inboxmax.invalid>');
});
