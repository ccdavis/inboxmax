/**
 * Composing and sending against the fake mailbox, checking the message as it
 * would have gone to the SMTP server (the server's test outbox).
 */
import { test, expect } from '@playwright/test';
import { signUpWithMailbox } from './helpers.js';

const REFUSED = 'nobody@refused.invalid';

async function openCompose(page) {
  await page.getByRole('button', { name: /Compose/ }).click();
  const dialog = page.getByRole('dialog', { name: 'New message' });
  await expect(dialog.getByLabel('To')).toBeFocused();
  return dialog;
}

async function addRecipients(dialog, label, text) {
  const input = dialog.getByLabel(label, { exact: true });
  await input.fill(text);
  await input.press('Enter');
}

async function outbox(page) {
  const response = await page.request.get('/api/test/outbox');
  expect(response.ok()).toBe(true);
  return response.json();
}

test('sends a message with Cc and Bcc exactly as written', async ({ page }) => {
  const me = await signUpWithMailbox(page);
  const dialog = await openCompose(page);
  await expect(dialog).toContainText(me);

  await addRecipients(dialog, 'To', '"Chen, Sarah" <sarah.chen@acme.example>, bob@acme.example');
  await expect(dialog.getByRole('list', { name: 'To recipients' })).toContainText('Chen, Sarah <sarah.chen@acme.example>');
  await dialog.getByRole('button', { name: 'Cc', exact: true }).click();
  await addRecipients(dialog, 'Cc', 'Ann <ann@acme.example>');
  await dialog.getByRole('button', { name: 'Bcc', exact: true }).click();
  await addRecipients(dialog, 'Bcc', 'secret@acme.example');
  await dialog.getByLabel('Subject').fill('Café plans — Grüße');
  await dialog.getByLabel('Message').fill('See you at noon.\n\n— me');
  await dialog.getByRole('button', { name: 'Send' }).click();

  await expect(page.getByRole('status')).toHaveText(/Message sent to Chen, Sarah and 3 more\./);
  await expect(dialog).toBeHidden();

  const [sent] = await outbox(page);
  expect(sent.account).toBe(me);
  expect(sent.to.map((a) => a.email)).toEqual(['sarah.chen@acme.example', 'bob@acme.example']);
  expect(sent.cc).toEqual([{ name: 'Ann', email: 'ann@acme.example' }]);
  expect(sent.bcc).toEqual([{ name: null, email: 'secret@acme.example' }]);
  expect(sent.subject).toBe('Café plans — Grüße');
  expect(sent.body).toBe('See you at noon.\n\n— me');
  expect(sent.raw).toContain(`From: ${me}\r\n`);
  // A comma in a name is sent RFC 2047-encoded; the addresses are plain.
  expect(sent.raw).toMatch(/\r\nTo: \S+ <sarah\.chen@acme\.example>, bob@acme\.example\r\n/);
  expect(sent.raw).toContain('Cc: Ann <ann@acme.example>\r\n');
  expect(sent.raw).not.toContain('secret@acme.example');
  expect(sent.raw).toMatch(/Subject: =\?utf-8\?/i);
  expect(sent.raw).toContain(`Message-ID: <${sent.message_id}>`);
});

test('a refused recipient keeps the draft so it can be fixed and sent', async ({ page }) => {
  await signUpWithMailbox(page);
  const dialog = await openCompose(page);
  await addRecipients(dialog, 'To', `ok@acme.example, ${REFUSED}`);
  await dialog.getByLabel('Subject').fill('Try again');
  await dialog.getByLabel('Message').fill('Body');
  await dialog.getByRole('button', { name: 'Send' }).click();

  await expect(dialog.getByRole('alert')).toContainText(`<${REFUSED}>: mailbox unavailable`);
  expect(await outbox(page)).toEqual([]);

  await dialog.getByRole('button', { name: `Remove ${REFUSED}` }).click();
  await dialog.getByRole('button', { name: 'Send' }).click();
  await expect(page.getByRole('status')).toHaveText('Message sent to ok@acme.example.');
  const sent = await outbox(page);
  expect(sent.map((m) => m.to.map((a) => a.email))).toEqual([['ok@acme.example']]);
});

test('catches missing and unreadable recipients and a missing subject', async ({ page }) => {
  await signUpWithMailbox(page);
  const dialog = await openCompose(page);

  await dialog.getByRole('button', { name: 'Send' }).click();
  await expect(dialog.getByRole('alert')).toHaveText('Add at least one recipient');

  await dialog.getByLabel('To').fill('someone@');
  await dialog.getByRole('button', { name: 'Send' }).click();
  await expect(dialog.getByRole('alert')).toHaveText('“someone@” is not a valid email address');
  await expect(dialog.getByLabel('To')).toBeFocused();

  await dialog.getByLabel('To').fill('someone@acme.example');
  await dialog.getByRole('button', { name: 'Send' }).click();
  const question = dialog.getByRole('group', { name: 'Send without a subject?' });
  await expect(question).toBeVisible();
  expect(await outbox(page)).toEqual([]);
  await question.getByRole('button', { name: 'Send anyway' }).click();
  await expect(page.getByRole('status')).toHaveText('Message sent to someone@acme.example.');
  const [sent] = await outbox(page);
  expect(sent.subject).toBe('');
});

test('discarding a draft asks first, and closing an empty one does not', async ({ page }) => {
  await signUpWithMailbox(page);
  let dialog = await openCompose(page);
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();

  dialog = await openCompose(page);
  await dialog.getByLabel('Message').fill('Unfinished');
  await page.keyboard.press('Escape');
  const question = dialog.getByRole('group', { name: 'Discard this message?' });
  await question.getByRole('button', { name: 'Keep editing' }).click();
  await expect(dialog.getByLabel('Message')).toHaveValue('Unfinished');

  // The inbox behind the dialog cannot be used meanwhile.
  const composeButton = page.getByRole('button', { name: /Compose/ });
  expect(await composeButton.evaluate((button) => button.closest('[inert]') !== null)).toBe(true);

  await dialog.getByRole('button', { name: 'Close' }).click();
  await dialog.getByRole('group', { name: 'Discard this message?' }).getByRole('button', { name: 'Discard' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('button', { name: /Compose/ })).toBeVisible();
  expect(await outbox(page)).toEqual([]);
});

test.describe('on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  test('the compose dialog fills the screen and sends with Ctrl+Enter', async ({ page }) => {
    await signUpWithMailbox(page);
    const dialog = await openCompose(page);
    const box = await dialog.boundingBox();
    expect(box.width).toBeGreaterThanOrEqual(389);
    expect(box.height).toBeGreaterThanOrEqual(843);
    await expect(dialog.getByRole('button', { name: 'Send' })).toBeInViewport();

    await addRecipients(dialog, 'To', 'a@acme.example');
    await dialog.getByLabel('Subject').fill('From my phone');
    await dialog.getByLabel('Message').press('Control+Enter');
    await expect(page.getByRole('status')).toHaveText('Message sent to a@acme.example.');
  });
});
