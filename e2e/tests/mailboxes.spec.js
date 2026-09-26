/**
 * The full web stack against the server's generated demo mailbox
 * (INBOXMAX_FAKE_MAIL=1): register, connect mailboxes, read, switch.
 */
import { test, expect } from '@playwright/test';
import { connect, register } from './helpers.js';

test('connect two mailboxes, read a message, and switch between them', async ({ page }) => {
  await register(page);

  // A rejected mailbox login is explained on the form.
  await connect(page, `work-${Date.now()}@work.example`, 'wrong-password');
  await expect(page.getByRole('alert')).toContainText('rejected');

  const work = `work-${Date.now()}@work.example`;
  await connect(page, work);
  const main = page.getByRole('main');
  await expect(main.getByText('PR #47 merged: fix dashboard layout')).toBeVisible();
  await expect(page.getByRole('banner')).toContainText(work);

  // Decoded non-ASCII subject, and the reader.
  await main.getByText('PR #47 merged: fix dashboard layout').click();
  await expect(page.getByRole('heading', { name: 'PR #47 merged: fix dashboard layout', level: 1 })).toBeVisible();
  await page.getByRole('button', { name: 'Back to inbox' }).click();

  // Add a second mailbox; its sender names show the other domain.
  const home = `home-${Date.now()}@home.example`;
  await page.getByRole('button', { name: '+ Add mailbox' }).click();
  await expect(page.getByRole('heading', { name: 'Add a mailbox' })).toBeVisible();
  await connect(page, home);
  await expect(main.getByText('GitHub (home.example)')).toBeVisible();

  // Switch back.
  const mailboxes = page.getByRole('complementary');
  await mailboxes.getByRole('button', { name: work, exact: true }).click();
  await expect(main.getByText('GitHub (work.example)')).toBeVisible();
  await expect(mailboxes.getByRole('button', { name: work, exact: true })).toHaveAttribute('aria-current', 'true');

  // The choice and both mailboxes survive a reload (same session).
  await page.reload();
  await expect(main.getByText('GitHub (work.example)')).toBeVisible();
  await expect(mailboxes.getByRole('button', { name: home, exact: true })).toBeVisible();
});

test('removing a mailbox asks first', async ({ page }) => {
  await register(page);
  const first = `first-${Date.now()}@one.example`;
  const second = `second-${Date.now()}@two.example`;
  await connect(page, first);
  await expect(page.getByRole('main').getByText('GitHub (one.example)')).toBeVisible();
  await page.getByRole('button', { name: '+ Add mailbox' }).click();
  await connect(page, second);
  await expect(page.getByRole('main').getByText('GitHub (two.example)')).toBeVisible();

  const sidebar = page.getByRole('complementary');
  await sidebar.getByRole('button', { name: `Remove ${second}` }).click();
  const confirm = sidebar.getByRole('group', { name: `Remove ${second}` });
  await expect(confirm).toContainText('remembered emails will be deleted');
  await confirm.getByRole('button', { name: 'Remove' }).click();

  await expect(page.getByRole('main').getByText('GitHub (one.example)')).toBeVisible();
  await expect(sidebar.getByRole('button', { name: second, exact: true })).toHaveCount(0);
});
