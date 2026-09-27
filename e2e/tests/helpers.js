// Shared steps for specs that run the full web stack against the server's
// generated demo mailbox (INBOXMAX_FAKE_MAIL=1).
import { expect } from '@playwright/test';

export const unique = (prefix) => `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

/** Create a fresh web account and land on the connect screen. */
export async function register(page) {
  await page.goto('/register');
  await page.getByLabel('Email').fill(`${unique('user')}@example.com`);
  await page.getByLabel('Password', { exact: true }).fill('password123');
  await page.getByLabel('Confirm Password').fill('password123');
  await page.getByRole('button', { name: 'Create Account' }).click();
  await expect(page.getByRole('heading', { name: 'Connect your email' })).toBeVisible();
}

/** Fill in and submit the connect form. The fake mailbox accepts any password but "wrong-password". */
export async function connect(page, email, password = 'mail-password') {
  await page.getByLabel('Email').fill(email);
  await page.getByLabel(/^Password/).fill(password);
  await page.getByRole('button', { name: 'Connect Email Account' }).click();
}

/** Register and connect a new fake mailbox at `domain`; resolves to its address. */
export async function signUpWithMailbox(page, domain = 'acme.example') {
  await register(page);
  const address = `${unique('me')}@${domain}`;
  await connect(page, address);
  await expect(page.getByRole('main').getByText('PR #47 merged: fix dashboard layout')).toBeVisible();
  return address;
}

/** The value cell next to a header label in the open message ("From", "Reply-To", ...). */
export function headerRow(page, label) {
  return page.getByRole('article').locator('dt', { hasText: new RegExp(`^${label}$`) })
    .locator('xpath=following-sibling::dd[1]');
}
