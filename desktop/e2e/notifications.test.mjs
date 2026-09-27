// New mail while the desktop app runs, on the demo mailbox, whose new
// message is set to arrive a few seconds after the demo opens and which is
// checked every second. Notifications are written to a file, not shown.
// Run after `npm run build:test`.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { Session, startDriver } from './webdriver.mjs';

const APP = resolve(
  import.meta.dirname,
  `../../target/debug/inboxmax-desktop${process.platform === 'win32' ? '.exe' : ''}`,
);
const dataDir = mkdtempSync(join(tmpdir(), 'inboxmax-desktop-notifications-'));
const log = join(dataDir, 'notifications.txt');
let driver;

const notifications = () => (existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : []);

async function withApp(fn) {
  const session = await Session.create(driver.base, APP);
  try {
    await fn(session);
  } finally {
    await session.close();
  }
}

before(async () => {
  driver = await startDriver({
    env: {
      INBOXMAX_DATA_DIR: dataDir,
      INBOXMAX_NO_KEYCHAIN: '1',
      INBOXMAX_DEMO_ARRIVAL_SECONDS: '6',
      INBOXMAX_CHECK_SECONDS: '1',
      INBOXMAX_NOTIFICATION_LOG: log,
    },
  });
});

after(() => driver?.stop());

describe('Inbox Max desktop new mail', () => {
  it('shows new mail in the open inbox as soon as it comes in', () =>
    withApp(async (session) => {
      await (await session.find('button', { text: 'Try the demo mailbox' })).click();
      await session.find('main h2', { text: '4 new' });
      // Well within the page's own two-minute check.
      await session.find('main li', { text: 'New mail, just now', timeout: 20000 });
      await session.find('main h2', { text: '5 new' });
    }));

  it('notifies of new mail while the window is not in use', () =>
    withApp(async (session) => {
      // The demo reopens, and its message comes again a few seconds later.
      await session.find('main h2', { text: 'new' });
      rmSync(log, { force: true });
      await session.cmd('POST', '/window/minimize', {});

      const deadline = Date.now() + 20000;
      while (!notifications().length && Date.now() < deadline) await sleep(250);
      assert.deepEqual(notifications(), ['Inbox Max\tNew mail, just now']);

      // Only once for that message.
      await sleep(2500);
      assert.equal(notifications().length, 1);
    }));
});
