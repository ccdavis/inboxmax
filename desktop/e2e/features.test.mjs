// Desktop-only paths through WebDriver, on the built-in demo mailbox as a
// user would reach it (no INBOXMAX_FAKE_MAIL): the demo button, saving
// attachments into Downloads, sending and suggestions over IPC, delete
// with undo, and the server folders. Run after `npm run build:test`.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Session, startDriver } from './webdriver.mjs';

const APP = resolve(
  import.meta.dirname,
  `../../target/debug/inboxmax-desktop${process.platform === 'win32' ? '.exe' : ''}`,
);
const dataDir = mkdtempSync(join(tmpdir(), 'inboxmax-desktop-features-'));
const downloads = mkdtempSync(join(tmpdir(), 'inboxmax-downloads-'));
let driver;

async function withApp(fn) {
  const session = await Session.create(driver.base, APP);
  try {
    await fn(session);
  } finally {
    await session.close();
  }
}

async function click(session, selector, text) {
  await (await session.find(selector, { text })).click();
}

before(async () => {
  driver = await startDriver({
    env: {
      INBOXMAX_DATA_DIR: dataDir,
      INBOXMAX_DOWNLOAD_DIR: downloads,
      INBOXMAX_NO_KEYCHAIN: '1',
    },
  });
});

after(() => driver?.stop());

describe('Inbox Max desktop features', () => {
  it('opens the demo mailbox with new mail, the last-seen line, and saved emails', () =>
    withApp(async (session) => {
      // The first window is wide enough for the sidebar, not the phone layout.
      const width = await session.execute('return window.innerWidth');
      assert.ok(width >= 768, `window is ${width} CSS pixels wide`);

      await click(session, 'button', 'Try the demo mailbox');
      await session.find('main h2', { text: '4 new' });
      await session.find('main li [aria-label="Last seen marker"]');
      await session.find('aside', { text: 'Remembered' });
      await session.find('aside', { text: 'Flight confirmation' });
      await session.find('header', { text: 'demo@inboxmax.invalid' });
    }));

  it('saves an attachment into Downloads without replacing an earlier copy', () =>
    withApp(async (session) => {
      // The demo reopens on launch, no password needed.
      await click(session, 'main li button', 'Quick question about the API spec');
      await session.find('h1', { text: 'Quick question about the API spec' });
      const download = 'button[aria-label^="Download API spec v2 (draft).txt"]';
      await click(session, download);
      await session.find('[role="status"]', { text: 'Saved API spec v2 (draft).txt in Downloads.' });
      await click(session, download);
      await session.find('[role="status"]', { text: 'Saved API spec v2 (draft) (1).txt in Downloads.' });

      for (const name of ['API spec v2 (draft).txt', 'API spec v2 (draft) (1).txt']) {
        const path = join(downloads, name);
        assert.ok(existsSync(path), `${name} saved`);
        assert.equal(readFileSync(path, 'utf8'), 'PATCH /v2/items/{id} accepts partial updates.\n');
      }
    }));

  it('sends from the demo and suggests the recipient next time', () =>
    withApp(async (session) => {
      await click(session, 'button', 'Compose');
      const to = await session.find('[role="dialog"] input[role="combobox"]');
      await to.type('Dana Lee <dana@lee.example>\n');
      await (await session.find('[role="dialog"] input[type="text"]:not([role])')).type('Hello from the desktop');
      await click(session, '[role="dialog"] button[type="submit"]', 'Send');
      await session.find('[role="status"]', { text: 'Message sent to Dana Lee.' });

      await click(session, 'button', 'Compose');
      await (await session.find('[role="dialog"] input[role="combobox"]')).type('dan');
      await session.find('[role="option"]', { text: 'Dana Lee <dana@lee.example>' });
    }));

  it('deletes a message and brings it back with Undo', () =>
    withApp(async (session) => {
      await click(session, 'main li button', 'Team standup notes');
      await session.find('h1', { text: 'Team standup notes' });
      await click(session, 'article button', 'Delete');
      await session.find('[role="status"]', { text: 'Moved to Trash.' });
      const gone = await session.execute(
        'return ![...document.querySelectorAll("main li")].some((li) => li.textContent.includes("Team standup notes"))',
      );
      assert.equal(gone, true);

      await click(session, 'button', 'Undo');
      await session.find('[role="status"]', { text: 'Moved back to the inbox.' });
      await session.find('main li', { text: 'Team standup notes' });
    }));

  it('keeps a signature and starts new messages with it', () =>
    withApp(async (session) => {
      await click(session, 'aside button', 'Signature');
      await (await session.find('[role="dialog"] textarea')).type('Demo Person');
      await click(session, '[role="dialog"] button[type="submit"]', 'Save');
      await session.find('[role="status"]', { text: 'Signature saved.' });
      await click(session, 'button', 'Compose');
      await session.find('[role="dialog"] textarea');
      const body = await session.execute('return document.querySelector("[role=dialog] textarea").value');
      assert.equal(body, '\n\n-- \nDemo Person\n');
    }));

  it('shows images on request, which the app security policy lets load', () =>
    withApp(async (session) => {
      await (await session.find('input[aria-label^="Search emails"]')).type('shipped\n');
      await click(session, 'main li button', 'Your order has shipped!');
      await session.find('article', { text: 'Images in this email are blocked' });
      assert.equal(await session.execute('return document.querySelectorAll("article img").length'), 0);

      await session.execute(`
        window.__blocked = [];
        document.addEventListener('securitypolicyviolation', (e) => window.__blocked.push(e.blockedURI));
      `);
      await click(session, 'article button', 'Show images');
      await session.find('article img[alt="Wireless headphones"]');
      const drawn = await session.execute(`
        const img = document.querySelector('article img[alt="Wireless headphones"]');
        return img.decode().then(() => img.naturalWidth, () => 0);
      `);
      assert.equal(drawn, 160);
      // The remote pixel's host does not exist, but the policy let it try.
      assert.deepEqual(await session.execute('return window.__blocked'), []);
    }));

  it('reads the server folders: saves from Trash, moves back, and shows Junk', () =>
    withApp(async (session) => {
      await click(session, 'main li button', 'Quick question about the API spec');
      await click(session, 'article button', 'Delete');
      await session.find('[role="status"]', { text: 'Moved to Trash.' });

      await click(session, 'aside button', 'Server folders');
      await click(session, 'aside button', 'Trash');
      await click(session, 'main li button', 'Quick question about the API spec');
      await session.find('h1', { text: 'Quick question about the API spec' });
      await click(session, 'button[aria-label^="Download API spec v2 (draft).txt"]');
      // The earlier test saved two copies already.
      await session.find('[role="status"]', { text: 'Saved API spec v2 (draft) (2).txt in Downloads.' });
      assert.equal(
        readFileSync(join(downloads, 'API spec v2 (draft) (2).txt'), 'utf8'),
        'PATCH /v2/items/{id} accepts partial updates.\n',
      );

      await click(session, 'article button', 'Move to Inbox');
      await session.find('[role="status"]', { text: 'Moved to the inbox.' });
      await session.find('main', { text: 'Nothing in Trash.' });

      await click(session, 'aside button', 'Junk');
      await click(session, 'main li button', 'You have won a prize!');
      await session.find('h1', { text: 'You have won a prize!' });
      await click(session, 'article button', 'Back to Junk');
      await click(session, 'main button', 'Inbox');
      await session.find('main li', { text: 'Quick question about the API spec' });
    }));
});
