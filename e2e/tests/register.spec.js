import { test, expect } from '@playwright/test';

test.describe('Registration', () => {
  // Use a unique email per test run to avoid conflicts
  const email = `test-${Date.now()}@example.com`;

  test('shows registration form with all fields', async ({ page }) => {
    await page.goto('/register');

    await expect(page.locator('h1', { hasText: 'Create your account' })).toBeVisible();
    await expect(page.locator('input[type="text"]')).toBeVisible(); // display name
    await expect(page.locator('input[type="email"]')).toBeVisible();
    await expect(page.locator('input[type="password"]').first()).toBeVisible();
    await expect(page.locator('input[type="password"]').nth(1)).toBeVisible(); // confirm
    await expect(page.locator('button[type="submit"]', { hasText: 'Create Account' })).toBeVisible();
  });

  test('has Μ logo linking back to landing', async ({ page }) => {
    await page.goto('/register');

    const logo = page.locator('a', { hasText: 'Μ' });
    await expect(logo).toBeVisible();
    await expect(logo).toHaveAttribute('href', '/');
  });

  test('has link to sign in page', async ({ page }) => {
    await page.goto('/register');

    const link = page.locator('a', { hasText: 'Sign in' });
    await expect(link).toBeVisible();
    await link.click();
    await expect(page).toHaveURL('/signin');
  });

  test('shows error for mismatched passwords', async ({ page }) => {
    await page.goto('/register');

    await page.locator('input[type="email"]').fill('mismatch@example.com');
    await page.locator('input[type="password"]').first().fill('password123');
    await page.locator('input[type="password"]').nth(1).fill('differentpass');
    await page.locator('button[type="submit"]').click();

    await expect(page.locator('text=Passwords do not match')).toBeVisible();
  });

  test('shows error for short password', async ({ page }) => {
    await page.goto('/register');

    await page.locator('input[type="email"]').fill('short@example.com');
    await page.locator('input[type="password"]').first().fill('abc');
    await page.locator('input[type="password"]').nth(1).fill('abc');
    await page.locator('button[type="submit"]').click();

    await expect(page.locator('text=Password must be at least 8 characters')).toBeVisible();
  });

  test('successfully registers and continues to connect a mailbox', async ({ page }) => {
    await page.goto('/register');

    await page.locator('input[type="text"]').fill('Test User');
    await page.locator('input[type="email"]').fill(email);
    await page.locator('input[type="password"]').first().fill('password123');
    await page.locator('input[type="password"]').nth(1).fill('password123');
    await page.locator('button[type="submit"]').click();

    await expect(page).toHaveURL('/inbox');
    await expect(page.getByRole('heading', { name: 'Connect your email' })).toBeVisible({ timeout: 5000 });
  });

  test('shows error for duplicate email', async ({ page, request }) => {
    // Register via API first
    const dupEmail = `dup-${Date.now()}@example.com`;
    await request.post('/api/register', {
      data: { email: dupEmail, password: 'password123' },
    });

    // Try to register same email via UI
    await page.context().clearCookies();
    await page.goto('/register');
    await page.locator('input[type="email"]').fill(dupEmail);
    await page.locator('input[type="password"]').first().fill('password123');
    await page.locator('input[type="password"]').nth(1).fill('password123');
    await page.locator('button[type="submit"]').click();

    await expect(page.locator('text=already exists')).toBeVisible({ timeout: 5000 });
  });

  test('takes a screenshot of registration page', async ({ page }) => {
    await page.goto('/register');
    await expect(page.locator('h1', { hasText: 'Create your account' })).toBeVisible();
    await page.screenshot({ path: 'screenshots/register.png', fullPage: true });
  });

  test('redirects to the inbox if already logged in', async ({ page }) => {
    const authEmail = `redir-${Date.now()}@example.com`;
    await page.goto('/register');
    await page.locator('input[type="email"]').fill(authEmail);
    await page.locator('input[type="password"]').first().fill('password123');
    await page.locator('input[type="password"]').nth(1).fill('password123');
    await page.locator('button[type="submit"]').click();
    await expect(page).toHaveURL('/inbox');

    await page.goto('/register');
    await expect(page).toHaveURL('/inbox');
  });
});
