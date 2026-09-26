/**
 * Reply, Reply all, and Forward against the fake mailbox, checking the sent
 * message's recipients, quoting, and threading headers.
 */
import { test, expect } from '@playwright/test';
import { signUpWithMailbox } from './helpers.js';

const SARAH_SUBJECT = 'Quick question about the API spec';
// The fake mailbox's Message-IDs are "<uid>.<uidvalidity>@fake.inboxmax.invalid";
// Sarah's message is the third newest.
const SARAH_ID = '998.1@fake.inboxmax.invalid';

async function open(page, subject) {
  await page.getByRole('main').getByText(subject).click();
  await expect(page.getByRole('heading', { name: subject, level: 1 })).toBeVisible();
}

async function lastSent(page) {
  const sent = await (await page.request.get('/api/test/outbox')).json();
  const message = sent.at(-1);
  // Unfold long headers so they can be matched on one line.
  return { ...message, headers: message.raw.split('\r\n\r\n')[0].replace(/\r\n[ \t]+/g, ' ') };
}

async function send(page, dialog) {
  await dialog.getByRole('button', { name: 'Send' }).click();
  await expect(page.getByRole('status')).toContainText('Message sent to');
}

test('a reply goes to the sender, quotes the message, and continues the thread', async ({ page }) => {
  const me = await signUpWithMailbox(page);
  await open(page, SARAH_SUBJECT);
  await page.getByRole('button', { name: 'Reply', exact: true }).click();

  const dialog = page.getByRole('dialog', { name: 'Reply' });
  await expect(dialog.getByRole('list', { name: 'To recipients' }))
    .toHaveText(/^Sarah Chen \(acme\.example\) <sarah\.chen@acme\.example>×$/);
  await expect(dialog.getByRole('list', { name: 'Cc recipients' })).toHaveCount(0);
  await expect(dialog.getByLabel('Subject')).toHaveValue(`Re: ${SARAH_SUBJECT}`);
  const body = dialog.getByLabel('Message');
  await expect(body).toBeFocused();
  await expect(body).toHaveValue(/wrote:\n> Hi,\n>\n> Does the v2 spec still allow partial updates\?\n> Bob thinks we dropped them\./);
  // The cursor starts above the quote.
  await page.keyboard.type('Yes, they are still in.');
  await send(page, dialog);

  const sent = await lastSent(page);
  expect(sent.to.map((a) => a.email)).toEqual(['sarah.chen@acme.example']);
  expect(sent.cc).toEqual([]);
  expect(sent.subject).toBe(`Re: ${SARAH_SUBJECT}`);
  expect(sent.body.startsWith('Yes, they are still in.\n\nOn ')).toBe(true);
  expect(sent.headers).toContain(`In-Reply-To: <${SARAH_ID}>`);
  expect(sent.headers).toContain(`References: <api-spec-kickoff@acme.example> <${SARAH_ID}>`);
  expect(sent.headers).toContain(`From: ${me}`);
});

test('Reply all copies the other recipients but never me', async ({ page }) => {
  const me = await signUpWithMailbox(page);
  await open(page, SARAH_SUBJECT);
  await page.getByRole('button', { name: 'Reply all' }).click();

  const dialog = page.getByRole('dialog', { name: 'Reply all' });
  await expect(dialog.getByRole('list', { name: 'To recipients' })).toContainText('sarah.chen@acme.example');
  await expect(dialog.getByRole('list', { name: 'Cc recipients' })).toHaveText('Bob Park <bob.park@acme.example>×');
  await send(page, dialog);

  const sent = await lastSent(page);
  expect(sent.to.map((a) => a.email)).toEqual(['sarah.chen@acme.example']);
  expect(sent.cc.map((a) => a.email)).toEqual(['bob.park@acme.example']);
  expect([...sent.to, ...sent.cc].map((a) => a.email)).not.toContain(me);
});

test('replies go to Reply-To when the sender set one', async ({ page }) => {
  await signUpWithMailbox(page);

  await open(page, 'Invitation: Design review @ Wed 2pm');
  await page.getByRole('button', { name: 'Reply', exact: true }).click();
  let dialog = page.getByRole('dialog', { name: 'Reply' });
  await expect(dialog.getByRole('list', { name: 'To recipients' })).toHaveText('Sarah Chen <sarah.chen@acme.example>×');
  await send(page, dialog);
  expect((await lastSent(page)).to.map((a) => a.email)).toEqual(['sarah.chen@acme.example']);

  await page.getByRole('button', { name: 'Back to inbox' }).click();
  await open(page, 'PR #47 merged: fix dashboard layout');
  // Only this mailbox received it, so Reply all would add no one.
  await expect(page.getByRole('button', { name: 'Reply all' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Reply', exact: true }).click();
  dialog = page.getByRole('dialog', { name: 'Reply' });
  await expect(dialog.getByRole('list', { name: 'To recipients' })).toContainText('reply+a1b2c3@reply.github.com');
});

test('a forward carries the original headers and text, but no threading', async ({ page }) => {
  await signUpWithMailbox(page);
  await open(page, 'PR #47 merged: fix dashboard layout');
  await page.getByRole('button', { name: 'Forward' }).click();

  const dialog = page.getByRole('dialog', { name: 'Forward' });
  await expect(dialog.getByLabel('To')).toBeFocused();
  await expect(dialog.getByLabel('Subject')).toHaveValue('Fwd: PR #47 merged: fix dashboard layout');
  const body = dialog.getByLabel('Message');
  await expect(body).toHaveValue(/---------- Forwarded message ----------\nFrom: GitHub \(acme\.example\) <notifications@github\.com>\n/);
  // The HTML body, as text, with its link target written out.
  await expect(body).toHaveValue(/Read more at example\.com \(https:\/\/example\.com\/\)\./);

  await dialog.getByLabel('To').fill('colleague@acme.example');
  await send(page, dialog);
  const sent = await lastSent(page);
  expect(sent.to.map((a) => a.email)).toEqual(['colleague@acme.example']);
  expect(sent.headers).not.toContain('In-Reply-To:');
  expect(sent.headers).not.toContain('References:');
});
