import { test, expect } from '@playwright/test';

test.describe('Landing Page (anonymous)', () => {
  test('shows hero Μ symbol and branding', async ({ page }) => {
    await page.goto('/');

    // Hero Μ should be visible
    const heroMu = page.locator('text=Μ').first();
    await expect(heroMu).toBeVisible();

    // "Inbox Max" text in hero heading
    await expect(page.locator('h1', { hasText: 'Inbox' })).toBeVisible();
    await expect(page.locator('h1', { hasText: 'Max' })).toBeVisible();

    // Tagline (in the hero section, not the footer)
    await expect(page.getByText('Maximum simplicity.', { exact: true })).toBeVisible();

    // Subtitle copy
    await expect(page.getByText('The email client for people who read subject lines.')).toBeVisible();
  });

  test('has Get Started and Sign In links', async ({ page }) => {
    await page.goto('/');

    const getStarted = page.locator('nav a', { hasText: 'Get Started' });
    await expect(getStarted).toBeVisible();
    await expect(getStarted).toHaveAttribute('href', '/register');

    const signIn = page.locator('nav a', { hasText: 'Sign In' });
    await expect(signIn).toBeVisible();
    await expect(signIn).toHaveAttribute('href', '/signin');
  });

  test('shows three feature cards', async ({ page }) => {
    await page.goto('/');

    await expect(page.locator('text=Since Last Open')).toBeVisible();
    await expect(page.locator('text=Remember This')).toBeVisible();
    await expect(page.locator('text=Any Provider')).toBeVisible();
  });

  test('shows how-it-works section', async ({ page }) => {
    await page.goto('/');

    await expect(page.locator('text=How it works')).toBeVisible();
    await expect(page.locator('text=Create an account')).toBeVisible();
    await expect(page.locator('text=Connect your email').first()).toBeVisible();
    await expect(page.getByRole('heading', { name: "See what's new" })).toBeVisible();
  });

  test('shows final call to action', async ({ page }) => {
    await page.goto('/');

    await expect(page.locator('text=Ready to simplify your inbox?')).toBeVisible();
    // Bottom CTA links to register
    const bottomCta = page.locator('a', { hasText: "Get Started — It's Free" }).last();
    await expect(bottomCta).toBeVisible();
    await expect(bottomCta).toHaveAttribute('href', '/register');
  });

  test('shows footer with branding', async ({ page }) => {
    await page.goto('/');

    const footer = page.locator('footer');
    await expect(footer).toBeVisible();
    await expect(footer.locator('text=Μ')).toBeVisible();
  });

  test('stats strip shows key benefits', async ({ page }) => {
    await page.goto('/');

    await expect(page.locator('text=Unread count anxiety')).toBeVisible();
    await expect(page.locator('text=To check your email')).toBeVisible();
    await expect(page.locator('text=IMAP provider works')).toBeVisible();
  });

  test('Get Started navigates to /register', async ({ page }) => {
    await page.goto('/');
    await page.locator('nav a', { hasText: 'Get Started' }).click();
    await expect(page).toHaveURL('/register');
  });

  test('Sign In navigates to /signin', async ({ page }) => {
    await page.goto('/');
    await page.locator('nav a', { hasText: 'Sign In' }).click();
    await expect(page).toHaveURL('/signin');
  });

  test('takes a screenshot of landing page', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('h1', { hasText: 'Inbox' })).toBeVisible();
    await page.screenshot({ path: 'screenshots/landing-anonymous.png', fullPage: true });
  });

  test('shows 404 for unknown routes', async ({ page }) => {
    await page.goto('/nonexistent');
    await expect(page.locator('text=404')).toBeVisible();
    await expect(page.locator('text=Page not found')).toBeVisible();
  });
});
