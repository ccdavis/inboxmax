import { test, expect } from '@playwright/test';

test.describe('Branding', () => {
  test('landing page has large hero Μ', async ({ page }) => {
    await page.goto('/');

    // Find the hero Μ by its text content — it's the large one in the main content area
    const allMu = page.locator('text=Μ');
    // There should be at least 2: header + hero
    await expect(allMu.first()).toBeVisible();
    const count = await allMu.count();
    expect(count).toBeGreaterThanOrEqual(2);
  });

  test('landing page header shows Μ InboxMax branding', async ({ page }) => {
    await page.goto('/');

    const header = page.locator('header');
    await expect(header.locator('text=Μ')).toBeVisible();
    await expect(header.locator('text=Inbox')).toBeVisible();
    await expect(header.locator('text=Max')).toBeVisible();
  });

  test('register page shows Μ logo', async ({ page }) => {
    await page.goto('/register');
    await expect(page.locator('text=Μ').first()).toBeVisible();
  });

  test('signin page shows Μ logo', async ({ page }) => {
    await page.goto('/signin');
    await expect(page.locator('text=Μ').first()).toBeVisible();
  });

  test('connect page shows Μ logo', async ({ page }) => {
    // Register first to access connect page
    const email = `brand-${Date.now()}@example.com`;
    await page.goto('/register');
    await page.locator('input[type="email"]').fill(email);
    await page.locator('input[type="password"]').first().fill('password123');
    await page.locator('input[type="password"]').nth(1).fill('password123');
    await page.locator('button[type="submit"]').click();
    await expect(page).toHaveURL('/');

    await page.goto('/inbox');
    await expect(page.locator('text=Μ').first()).toBeVisible();
  });
});
