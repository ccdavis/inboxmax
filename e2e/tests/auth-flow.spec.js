import { test, expect } from '@playwright/test';

test.describe('Full auth flow', () => {
  const email = `flow-${Date.now()}@example.com`;
  const password = 'password123';

  test('register → connect page → logged-in landing → sign out → sign in', async ({ page }) => {
    // 1. Start at landing page (anonymous)
    await page.goto('/');
    await expect(page.getByText('Maximum simplicity.', { exact: true })).toBeVisible();

    // 2. Navigate to register
    await page.locator('nav a', { hasText: 'Get Started' }).click();
    await expect(page).toHaveURL('/register');

    // 3. Fill registration form
    await page.locator('input[type="text"]').fill('Flow Test');
    await page.locator('input[type="email"]').fill(email);
    await page.locator('input[type="password"]').first().fill(password);
    await page.locator('input[type="password"]').nth(1).fill(password);
    await page.locator('button[type="submit"]').click();

    // 4. A new account goes straight to connecting a mailbox
    await expect(page).toHaveURL('/inbox');
    await expect(page.getByRole('heading', { name: 'Connect your email' })).toBeVisible({ timeout: 5000 });

    // 5. The logged-in landing page links back to the inbox
    await page.goto('/');
    await expect(page.locator('text=Welcome back')).toBeVisible({ timeout: 5000 });
    await page.getByRole('link', { name: 'Take me to Inbox Max' }).click();
    await expect(page).toHaveURL('/inbox');

    // 6. Sign out from the connect screen
    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect(page).toHaveURL('/signin');

    // 7. Anonymous landing page, also after a reload
    await page.goto('/');
    await expect(page.getByText('Maximum simplicity.', { exact: true })).toBeVisible({ timeout: 5000 });
    await page.reload();
    await expect(page.getByText('Maximum simplicity.', { exact: true })).toBeVisible({ timeout: 5000 });

    // 8. Sign in again and land in the inbox
    await page.locator('nav a', { hasText: 'Sign In' }).click();
    // Ask for the textboxes: while the route swaps, a loose "Email" label
    // match can land on landing-page sections that mention email.
    await page.getByRole('textbox', { name: 'Email' }).fill(email);
    await page.getByRole('textbox', { name: 'Password' }).fill(password);
    await page.locator('button[type="submit"]').click();
    await expect(page).toHaveURL('/inbox');
    await expect(page.getByRole('heading', { name: 'Connect your email' })).toBeVisible({ timeout: 5000 });
  });

  test('/inbox redirects to /signin when not logged in', async ({ page }) => {
    // Clear cookies
    await page.context().clearCookies();
    await page.goto('/inbox');
    await expect(page).toHaveURL('/signin');
  });

  test('/inbox is bookmarkable when logged in', async ({ page }) => {
    // Register and stay logged in
    const bookmarkEmail = `bookmark-${Date.now()}@example.com`;
    await page.goto('/register');
    await page.locator('input[type="email"]').fill(bookmarkEmail);
    await page.locator('input[type="password"]').first().fill(password);
    await page.locator('input[type="password"]').nth(1).fill(password);
    await page.locator('button[type="submit"]').click();
    await expect(page).toHaveURL('/inbox');

    // Go directly to /inbox
    await page.goto('/inbox');
    await expect(page).toHaveURL('/inbox');
    // Should see the connect form (no IMAP), not a redirect
    await expect(page.locator('text=Connect your email')).toBeVisible({ timeout: 5000 });
  });
});
