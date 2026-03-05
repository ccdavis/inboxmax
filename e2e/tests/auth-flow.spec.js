import { test, expect } from '@playwright/test';

test.describe('Full auth flow', () => {
  const email = `flow-${Date.now()}@example.com`;
  const password = 'password123';

  test('register → logged-in landing → inbox → connect page → sign out → sign in', async ({ page }) => {
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

    // 4. Should be on logged-in landing
    await expect(page).toHaveURL('/');
    await expect(page.locator('text=Welcome back')).toBeVisible({ timeout: 5000 });
    await page.screenshot({ path: 'screenshots/landing-logged-in.png', fullPage: true });

    // 5. Click "Take me to Inbox Max" → /inbox
    await page.locator('button', { hasText: 'Take me to Inbox Max' }).click();
    await expect(page).toHaveURL('/inbox');

    // 6. Should see IMAP connect form (no IMAP account yet)
    await expect(page.locator('text=Connect your email')).toBeVisible({ timeout: 5000 });
    await page.screenshot({ path: 'screenshots/connect-account.png', fullPage: true });

    // 7. Sign out
    await page.goto('/');
    await page.locator('button', { hasText: 'Sign out' }).click();

    // 8. Should see anonymous landing page
    await expect(page.getByText('Maximum simplicity.', { exact: true })).toBeVisible({ timeout: 5000 });

    // 9. Sign in again
    await page.locator('nav a', { hasText: 'Sign In' }).click();
    await page.locator('input[type="email"]').fill(email);
    await page.locator('input[type="password"]').fill(password);
    await page.locator('button[type="submit"]').click();

    // 10. Back to logged-in landing
    await expect(page).toHaveURL('/');
    await expect(page.locator('text=Welcome back')).toBeVisible({ timeout: 5000 });
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
    await expect(page).toHaveURL('/');

    // Go directly to /inbox
    await page.goto('/inbox');
    await expect(page).toHaveURL('/inbox');
    // Should see the connect form (no IMAP), not a redirect
    await expect(page.locator('text=Connect your email')).toBeVisible({ timeout: 5000 });
  });
});
