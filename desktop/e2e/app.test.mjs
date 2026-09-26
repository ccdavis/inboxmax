// End-to-end tests for the desktop app through WebDriver (tauri-driver).
// Run with `npm run test:e2e` after `npm run build:test`; on Linux this needs
// a display (xvfb-run) and WebKitWebDriver. See desktop/README.md.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Session, startDriver } from './webdriver.mjs';

const APP = resolve(import.meta.dirname, '../../target/debug/inboxmax-desktop');
const SCREENSHOTS = process.env.SCREENSHOT_DIR;
// Saved passwords need an unlocked OS keychain; CI runs without one.
const KEYCHAIN = process.env.INBOXMAX_TEST_KEYCHAIN === '1';

const dataDir = mkdtempSync(join(tmpdir(), 'inboxmax-desktop-'));
let driver;

async function launch() {
  return Session.create(driver.base, APP);
}

async function saveScreenshot(session, name) {
  if (!SCREENSHOTS) return;
  mkdirSync(SCREENSHOTS, { recursive: true });
  writeFileSync(join(SCREENSHOTS, `${name}.png`), await session.screenshot());
}

/** Run `fn` in a fresh app launch, keeping a screenshot if it fails. */
async function withApp(name, fn) {
  const session = await launch();
  try {
    await fn(session);
  } catch (error) {
    await saveScreenshot(session, `${name}-failure`).catch(() => {});
    throw error;
  } finally {
    await session.close();
  }
}

async function connect(session, email) {
  const emailField = await session.find('input[type="email"]');
  // The reconnect screen fills in the address already.
  if ((await session.execute('return arguments[0].value', [emailField.ref])) !== email) {
    await emailField.type(email);
  }
  await (await session.find('input[type="password"]')).type('mail-password');
  await (await session.find('button[type="submit"]')).click();
}

before(async () => {
  driver = await startDriver({
    env: {
      INBOXMAX_FAKE_MAIL: '1',
      INBOXMAX_DATA_DIR: dataDir,
      ...(KEYCHAIN ? {} : { INBOXMAX_NO_KEYCHAIN: '1' }),
    },
  });
});

after(() => driver?.stop());

describe('Inbox Max desktop', () => {
  it('opens to the connect screen, then shows the inbox without a sign-in', () =>
    withApp('first-launch', async (session) => {
      await session.find('h1', { text: 'Connect your email' });
      const signOut = await session.execute(
        'return [...document.querySelectorAll("button")].some((b) => b.textContent.trim() === "Sign out")',
      );
      assert.equal(signOut, false, 'the desktop app has no sign-out');
      const keychainBox = await session.execute('return !!document.querySelector("input[type=checkbox]")');
      assert.equal(keychainBox, KEYCHAIN);
      await saveScreenshot(session, 'desktop-connect');

      await connect(session, 'me@work.example');
      await session.find('main li', { text: 'PR #47 merged' });
      await session.find('header', { text: 'me@work.example' });
      await saveScreenshot(session, 'desktop-inbox');

      // Open a message and come back.
      await (await session.find('main li button', { text: 'PR #47 merged' })).click();
      await session.find('.prose h2', { text: 'PR #47 merged' });
      await saveScreenshot(session, 'desktop-reader');
      await (await session.find('button', { text: 'Back to inbox' })).click();
      await session.find('main li', { text: 'PR #47 merged' });
    }));

  it('manages several mailboxes', () =>
    withApp('mailboxes', async (session) => {
      // Without a keychain, the first mailbox needs its password again.
      if (!KEYCHAIN) {
        await session.find('h1', { text: 'Reconnect your mailbox' });
        await connect(session, 'me@work.example');
      }
      // Only mail since the last visit is shown, and the demo mailbox has none.
      await session.find('main h2', { text: 'No new emails' });
      await session.find('header', { text: 'me@work.example' });

      await (await session.find('aside button', { text: '+ Add mailbox' })).click();
      await session.find('h1', { text: 'Add a mailbox' });
      await connect(session, 'me@home.example');
      await session.find('main li', { text: 'GitHub (home.example)' });

      await (await session.find('aside li button', { text: 'me@work.example' })).click();
      await session.find('header', { text: 'me@work.example' });
      await session.find('main h2', { text: 'No new emails' });
      const current = await session.find('aside button[aria-current="true"]');
      assert.match(await current.text(), /me@work\.example/);
      await saveScreenshot(session, 'desktop-two-mailboxes');
    }));

  it('keeps mailboxes across launches', () =>
    withApp('relaunch', async (session) => {
      if (KEYCHAIN) {
        // Saved passwords reconnect both mailboxes automatically.
        await session.find('header', { text: 'me@work.example' });
        await session.find('aside li', { text: 'me@home.example' });
        const locked = await session.execute('return document.body.textContent.includes("Needs password")');
        assert.equal(locked, false);
      } else {
        await session.find('h1', { text: 'Reconnect your mailbox' });
        await session.find('input[type="email"]');
        const email = await session.execute('return document.querySelector("input[type=email]").value');
        assert.equal(email, 'me@work.example');
      }
    }));
});
