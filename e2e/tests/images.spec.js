/**
 * Images in email, against the fake mailbox's shipping notice: nothing is
 * fetched from the sender's servers until the user asks, and then without
 * saying where from.
 */
import { test, expect } from '@playwright/test';
import { signUpWithMailbox } from './helpers.js';

const SHIPPED = 'Your order has shipped!';
// A 1x1 transparent GIF.
const PIXEL = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

async function openShipped(page) {
  await page.getByRole('textbox', { name: /Search emails/ }).fill('shipped');
  await page.keyboard.press('Enter');
  await page.getByRole('main').getByText(SHIPPED).click();
  await expect(page.getByRole('heading', { name: SHIPPED, level: 1 })).toBeVisible();
}

test('images load only when asked, and the sender learns nothing of the page', async ({ page }) => {
  const fetched = [];
  await page.route('https://images.inboxmax.invalid/**', (route) => {
    fetched.push({ url: route.request().url(), referer: route.request().headers().referer });
    return route.fulfill({ contentType: 'image/gif', body: PIXEL });
  });
  await signUpWithMailbox(page);

  await openShipped(page);
  const article = page.getByRole('article');
  await expect(article.getByText('Wireless headphones, arriving Thursday.')).toBeVisible();
  await expect(article.getByText('Images in this email are blocked to protect your privacy.')).toBeVisible();
  await expect(article.locator('img')).toHaveCount(0);

  await article.getByRole('button', { name: 'Show images' }).click();
  const picture = article.getByRole('img', { name: 'Wireless headphones' });
  await expect(picture).toBeVisible();
  // Drawn, not just given room.
  await expect.poll(() => picture.evaluate((img) => img.complete && img.naturalWidth)).toBe(160);
  // The picture in the message itself, and the remote tracking pixel;
  // the inline cid: part cannot be shown and is left out.
  await expect(article.locator('img')).toHaveCount(2);
  await expect(article.getByText(/Images in this email are blocked/)).toHaveCount(0);
  await expect.poll(() => fetched.length).toBe(1);
  expect(fetched[0].url).toBe('https://images.inboxmax.invalid/open.gif?id=demo');
  expect(fetched[0].referer).toBeUndefined();

  // Only for that message: back and in again, they are blocked once more.
  await article.getByRole('button', { name: 'Back to inbox' }).click();
  await openShipped(page);
  await expect(page.getByRole('article').getByRole('button', { name: 'Show images' })).toBeVisible();
  await expect(page.getByRole('article').locator('img')).toHaveCount(0);
  expect(fetched).toHaveLength(1);
});
