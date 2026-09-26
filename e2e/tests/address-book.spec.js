/**
 * The address book against the fake mailbox: filled from mail you open and
 * mail you send, suggested while addressing (always with the full address),
 * and editable.
 */
import { test, expect } from '@playwright/test';
import { signUpWithMailbox } from './helpers.js';

const SARAH_SUBJECT = 'Quick question about the API spec';

async function openAndReturn(page, subject) {
  await page.getByRole('main').getByText(subject).click();
  await expect(page.getByRole('heading', { name: subject, level: 1 })).toBeVisible();
  await page.getByRole('button', { name: 'Back to inbox' }).click();
}

async function openCompose(page) {
  await page.getByRole('button', { name: /Compose/ }).click();
  return page.getByRole('dialog', { name: 'New message' });
}

async function suggestionsFor(dialog, text) {
  const to = dialog.getByRole('combobox', { name: 'To' });
  await to.fill(text);
  return dialog.getByRole('listbox', { name: 'Suggestions for To' });
}

async function sendTo(page, recipients) {
  const dialog = await openCompose(page);
  await dialog.getByRole('combobox', { name: 'To' }).fill(recipients);
  await dialog.getByRole('combobox', { name: 'To' }).press('Enter');
  await dialog.getByLabel('Subject').fill('Hello');
  await dialog.getByRole('button', { name: 'Send' }).click();
  await expect(page.getByRole('status')).toContainText('Message sent to');
}

test('people whose mail you open are suggested, robots and you are not', async ({ page }) => {
  const me = await signUpWithMailbox(page);
  await openAndReturn(page, SARAH_SUBJECT);
  await openAndReturn(page, 'PR #47 merged: fix dashboard layout');
  await openAndReturn(page, 'Invitation: Design review @ Wed 2pm');

  const dialog = await openCompose(page);
  const list = await suggestionsFor(dialog, 'sar');
  await expect(list.getByRole('option')).toHaveText(['Sarah Chen <sarah.chen@acme.example>']);
  await dialog.getByRole('combobox', { name: 'To' }).press('Enter');
  await expect(dialog.getByRole('list', { name: 'To recipients' })).toHaveText('Sarah Chen <sarah.chen@acme.example>×');

  // GitHub's notification address and reply token, the calendar robot, and
  // this mailbox's own address are never suggested.
  for (const text of ['notif', 'reply', 'calendar', me.slice(0, 6)]) {
    await suggestionsFor(dialog, text);
    await page.waitForTimeout(300);
    await expect(dialog.getByRole('combobox', { name: 'To' }), text).toHaveAttribute('aria-expanded', 'false');
  }
});

test('someone with two addresses is suggested twice, most written-to first', async ({ page }) => {
  await signUpWithMailbox(page);
  await openAndReturn(page, SARAH_SUBJECT);
  await sendTo(page, 'Sarah Chen <sarah@home.example>');

  // Her work address carries the name her mail was sent under (the fake
  // mailbox adds the domain); the home one, the name she was sent to.
  const dialog = await openCompose(page);
  const list = await suggestionsFor(dialog, 'chen');
  await expect(list.getByRole('option')).toHaveText([
    'Sarah Chen <sarah@home.example>',
    'Sarah Chen (acme.example) <sarah.chen@acme.example>',
  ]);
  // Pick the second with the keyboard.
  const to = dialog.getByRole('combobox', { name: 'To' });
  await to.press('ArrowDown');
  await to.press('Enter');
  await expect(dialog.getByRole('list', { name: 'To recipients' }))
    .toHaveText('Sarah Chen (acme.example) <sarah.chen@acme.example>×');

  // Escape closes the suggestions and leaves the message open.
  await suggestionsFor(dialog, 'sar');
  await expect(to).toHaveAttribute('aria-expanded', 'true');
  await to.press('Escape');
  await expect(to).toHaveAttribute('aria-expanded', 'false');
  await expect(dialog).toBeVisible();
});

test('the address book lists, renames, adds, and deletes entries', async ({ page }) => {
  await signUpWithMailbox(page);
  await openAndReturn(page, SARAH_SUBJECT);
  await sendTo(page, 'bob.park@acme.example');

  await page.getByRole('button', { name: 'Address book' }).click();
  const book = page.getByRole('dialog', { name: 'Address book' });
  const entries = book.getByRole('list', { name: 'Contacts' }).getByRole('listitem');
  await expect(entries).toHaveText([
    'No name <bob.park@acme.example>sent 1×EditDelete',
    'Sarah Chen (acme.example) <sarah.chen@acme.example>EditDelete',
  ]);

  // Rename; the name sticks even after opening mail that shows another.
  await book.getByRole('button', { name: 'Edit bob.park@acme.example' }).click();
  await book.getByLabel('Name for bob.park@acme.example').fill('Bob Park');
  await book.getByRole('button', { name: 'Save' }).click();
  await expect(entries.first()).toHaveText('Bob Park <bob.park@acme.example>sent 1×EditDelete');

  // Add by hand.
  await book.getByLabel('Name').fill('Dana Lee');
  await book.getByLabel('Email').fill('dana@lee.example');
  await book.getByRole('button', { name: 'Add' }).click();
  await expect(entries).toHaveCount(3);

  // Delete.
  await book.getByRole('button', { name: /^Delete Sarah Chen/ }).click();
  await expect(entries).toHaveCount(2);
  await page.keyboard.press('Escape');
  await expect(book).toBeHidden();

  const dialog = await openCompose(page);
  await expect((await suggestionsFor(dialog, 'bob')).getByRole('option')).toHaveText(['Bob Park <bob.park@acme.example>']);
  await expect((await suggestionsFor(dialog, 'lee')).getByRole('option')).toHaveText(['Dana Lee <dana@lee.example>']);
  await suggestionsFor(dialog, 'sarah');
  await page.waitForTimeout(300);
  await expect(dialog.getByRole('combobox', { name: 'To' })).toHaveAttribute('aria-expanded', 'false');
});
