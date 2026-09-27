/**
 * Archive and Delete against the fake mailbox: from the list and the reader,
 * each undoable, with the message leaving the inbox and search.
 */
import { test, expect } from '@playwright/test';
import { signUpWithMailbox } from './helpers.js';

const SARAH = 'Quick question about the API spec';

function row(page, subject) {
  return page.getByRole('main').locator('li[data-uid]', { hasText: subject });
}

async function search(page, text) {
  await page.getByRole('textbox', { name: /Search emails/ }).fill(text);
  await page.keyboard.press('Enter');
}

test('delete from the list, then undo', async ({ page }) => {
  await signUpWithMailbox(page);
  await row(page, SARAH).hover();
  await page.getByRole('button', { name: `Delete “${SARAH}”` }).click();

  await expect(page.getByRole('status')).toHaveText('Moved to Trash.');
  await expect(row(page, SARAH)).toHaveCount(0);
  // Gone after a reload too: it really left the inbox.
  await page.reload();
  await expect(row(page, 'PR #47 merged')).toBeVisible();
  await expect(row(page, SARAH)).toHaveCount(0);

  // Undo is offered right after a move: delete another and undo that.
  await row(page, 'Team standup notes').hover();
  await page.getByRole('button', { name: 'Delete “Team standup notes”' }).click();
  await expect(row(page, 'Team standup notes')).toHaveCount(0);
  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(page.getByRole('status')).toHaveText('Moved back to the inbox.');
  await expect(row(page, 'Team standup notes')).toBeVisible();
});

test('archive from the reader returns to the list, and search no longer finds it', async ({ page }) => {
  await signUpWithMailbox(page);
  await page.getByRole('main').getByText(SARAH).click();
  await expect(page.getByRole('heading', { name: SARAH, level: 1 })).toBeVisible();
  await page.getByRole('button', { name: 'Archive' }).click();

  await expect(page.getByRole('status')).toHaveText('Archived.');
  await expect(page.getByRole('heading', { name: SARAH, level: 1 })).toHaveCount(0);
  await expect(row(page, SARAH)).toHaveCount(0);
  await search(page, 'API spec');
  await expect(page.getByText('No emails match “API spec”')).toBeVisible();

  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(page.getByRole('status')).toHaveText('Moved back to the inbox.');
  await search(page, 'API spec');
  await expect(row(page, SARAH)).toBeVisible();
});

test('a remembered message loses its star when moved and gets it back on undo', async ({ page }) => {
  await signUpWithMailbox(page);
  await row(page, SARAH).hover();
  await page.getByRole('button', { name: `Remember “${SARAH}”` }).click();
  const remembered = page.getByRole('complementary').getByRole('button', { name: /Remembered/ });
  await expect(remembered).toBeVisible();

  await row(page, SARAH).hover();
  await page.getByRole('button', { name: `Delete “${SARAH}”` }).click();
  await expect(page.getByRole('status')).toHaveText('Moved to Trash.');
  await expect(remembered).toHaveCount(0);

  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(page.getByRole('status')).toHaveText('Moved back to the inbox.');
  await expect(remembered).toBeVisible();
  await expect(page.getByRole('button', { name: `Forget “${SARAH}”` }).first()).toBeVisible();
});

test('undoing twice explains that the message is already back', async ({ page }) => {
  await signUpWithMailbox(page);
  await row(page, SARAH).hover();
  await page.getByRole('button', { name: `Archive “${SARAH}”` }).click();
  const undo = page.getByRole('button', { name: 'Undo' });
  await expect(undo).toBeVisible();
  // A second window, or a double click, restores it first.
  await page.request.post(
    `/api/accounts/${await page.evaluate(() => localStorage.getItem('inboxmax_active_account'))}/restore`,
    { data: { from: 'archive', message_id: '998.1@fake.inboxmax.invalid' } },
  );
  await undo.click();
  await expect(page.getByRole('alert')).toHaveText('Could not undo: The message is no longer in Archive');
  await expect(row(page, SARAH)).toBeVisible();
});
