/**
 * Signatures against the fake mailbox: set per mailbox, kept across
 * reloads, added to new messages and replies (above the quote), and sent.
 */
import { test, expect } from '@playwright/test';
import { connect, signUpWithMailbox, unique } from './helpers.js';

const sidebar = (page) => page.getByRole('complementary');

async function setSignature(page, text) {
  await sidebar(page).getByRole('button', { name: 'Signature' }).click();
  const dialog = page.getByRole('dialog', { name: 'Signature' });
  await dialog.getByRole('textbox').fill(text);
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(dialog).toBeHidden();
}

async function compose(page) {
  await page.getByRole('button', { name: /Compose/ }).click();
  return page.getByRole('dialog', { name: 'New message' });
}

test('a signature is added to new messages and sent with them', async ({ page }) => {
  await signUpWithMailbox(page);
  await setSignature(page, 'Ada Lovelace\nAnalyst, Acme\n\n');
  await expect(page.getByRole('status')).toHaveText('Signature saved.');

  // Kept on the server: still there after a reload.
  await page.reload();
  await expect(page.getByRole('main').getByText('PR #47 merged: fix dashboard layout')).toBeVisible();

  const dialog = await compose(page);
  const body = dialog.getByLabel('Message');
  await expect(body).toHaveValue('\n\n-- \nAda Lovelace\nAnalyst, Acme\n');
  await dialog.getByLabel('To', { exact: true }).fill('sarah@acme.example');
  await dialog.getByLabel('Subject').fill('Hello');
  await body.focus();
  await page.keyboard.press('Control+Home');
  await page.keyboard.type('See you at noon.');
  await dialog.getByRole('button', { name: 'Send' }).click();
  await expect(page.getByRole('status')).toHaveText('Message sent to sarah@acme.example.');

  const sent = (await (await page.request.get('/api/test/outbox')).json()).at(-1);
  expect(sent.body).toMatch(/^See you at noon\.\n\n-- \nAda Lovelace\nAnalyst, Acme\n?$/);
});

test('a reply has the signature above the quoted message', async ({ page }) => {
  await signUpWithMailbox(page);
  await setSignature(page, 'Ada');
  await page.getByRole('main').getByText('Quick question about the API spec').click();
  await page.getByRole('article').getByRole('button', { name: 'Reply', exact: true }).click();
  const body = page.getByRole('dialog', { name: 'Reply' }).getByLabel('Message');
  await expect(body).toHaveValue(/^\n\n-- \nAda\n\nOn .+ wrote:\n> /);
  // The cursor is where the reply goes, above the signature.
  expect(await body.evaluate((field) => field.selectionStart)).toBe(0);
});

test('each mailbox has its own signature, and it can be removed', async ({ page }) => {
  await signUpWithMailbox(page);
  await setSignature(page, 'Work me');

  await sidebar(page).getByRole('button', { name: '+ Add mailbox' }).click();
  await connect(page, `${unique('home')}@home.example`);
  await expect(page.getByRole('main').getByText('GitHub (home.example)')).toBeVisible();
  let dialog = await compose(page);
  await expect(dialog.getByLabel('Message')).toHaveValue('');
  await dialog.getByRole('button', { name: 'Close' }).click();

  await sidebar(page).getByRole('button', { name: /^me-/ }).click();
  await expect(page.getByRole('main').getByText('GitHub (acme.example)')).toBeVisible();
  dialog = await compose(page);
  await expect(dialog.getByLabel('Message')).toHaveValue('\n\n-- \nWork me\n');
  await dialog.getByRole('button', { name: 'Close' }).click();

  await setSignature(page, '');
  await expect(page.getByRole('status')).toHaveText('Signature removed.');
  dialog = await compose(page);
  await expect(dialog.getByLabel('Message')).toHaveValue('');
});
