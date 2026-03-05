import { test, expect } from '@playwright/test';

test.describe('Sign In', () => {
  const email = `signin-${Date.now()}@example.com`;
  const password = 'password123';

  // Register a user before sign-in tests
  test.beforeAll(async ({ request }) => {
    await request.post('/api/register', {
      data: { email, password, display_name: 'Sign In Test' },
    });
  });

  test('shows sign-in form', async ({ page }) => {
    await page.goto('/signin');

    await expect(page.locator('h1', { hasText: 'Welcome back' })).toBeVisible();
    await expect(page.locator('input[type="email"]')).toBeVisible();
    await expect(page.locator('input[type="password"]')).toBeVisible();
    await expect(page.locator('button[type="submit"]', { hasText: 'Sign In' })).toBeVisible();
  });

  test('has Μ logo linking back to landing', async ({ page }) => {
    await page.goto('/signin');

    const logo = page.locator('a', { hasText: 'Μ' });
    await expect(logo).toBeVisible();
    await expect(logo).toHaveAttribute('href', '/');
  });

  test('has link to register page', async ({ page }) => {
    await page.goto('/signin');

    const link = page.locator('a', { hasText: 'Get started' });
    await expect(link).toBeVisible();
    await link.click();
    await expect(page).toHaveURL('/register');
  });

  test('shows error for wrong credentials', async ({ page }) => {
    await page.goto('/signin');

    await page.locator('input[type="email"]').fill(email);
    await page.locator('input[type="password"]').fill('wrongpassword');
    await page.locator('button[type="submit"]').click();

    await expect(page.locator('text=Not authenticated')).toBeVisible({ timeout: 5000 });
  });

  test('successfully signs in and redirects to landing (logged in)', async ({ page }) => {
    await page.goto('/signin');

    await page.locator('input[type="email"]').fill(email);
    await page.locator('input[type="password"]').fill(password);
    await page.locator('button[type="submit"]').click();

    await expect(page).toHaveURL('/');
    await expect(page.locator('text=Welcome back')).toBeVisible({ timeout: 5000 });
    await expect(page.locator('text=Take me to Inbox Max')).toBeVisible();
  });

  test('redirects to /inbox after sign-in when that was the intended destination', async ({ page }) => {
    await page.context().clearCookies();
    // Try to access /inbox while logged out — should redirect to /signin
    await page.goto('/inbox');
    await expect(page).toHaveURL('/signin');

    // Sign in
    await page.locator('input[type="email"]').fill(email);
    await page.locator('input[type="password"]').fill(password);
    await page.locator('button[type="submit"]').click();

    // Should redirect to /inbox (the original intended destination)
    await expect(page).toHaveURL('/inbox');
    // Should see connect page (no IMAP configured)
    await expect(page.locator('text=Connect your email')).toBeVisible({ timeout: 5000 });
  });

  test('takes a screenshot of sign-in page', async ({ page }) => {
    await page.goto('/signin');
    await expect(page.locator('h1', { hasText: 'Welcome back' })).toBeVisible();
    await page.screenshot({ path: 'screenshots/signin.png', fullPage: true });
  });
});
