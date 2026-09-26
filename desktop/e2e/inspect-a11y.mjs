// Print the accessibility tree (AT-SPI, what Orca reads) of the inbox and
// reader screens, driving the app through WebDriver. Linux only; see
// desktop/README.md for how to run it.
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { Session, startDriver } from './webdriver.mjs';

const APP = resolve(import.meta.dirname, '../../target/debug/inboxmax-desktop');
const TREE = join(import.meta.dirname, 'a11y_tree.py');

function dump(label, roles) {
  console.log(`===== ${label}`);
  const result = spawnSync(process.env.PYTHON ?? 'python3', [TREE, roles.join(',')], { encoding: 'utf8' });
  console.log(result.stdout, result.stderr);
}

const driver = await startDriver({
  env: {
    INBOXMAX_FAKE_MAIL: '1',
    INBOXMAX_NO_KEYCHAIN: '1',
    INBOXMAX_DATA_DIR: mkdtempSync(join(tmpdir(), 'inboxmax-a11y-')),
  },
});
const session = await Session.create(driver.base, APP);
try {
  await session.find('h1', { text: 'Connect your email' });
  dump('connect', ['heading', 'form', 'entry', 'password text', 'push button', 'check box', 'link', 'alert']);

  await (await session.find('input[type="email"]')).type('me@work.example');
  await (await session.find('input[type="password"]')).type('password');
  await (await session.find('button[type="submit"]')).click();
  await session.find('main li', { text: 'PR #47' });
  await sleep(500); // let the accessibility tree catch up
  dump('inbox', [
    'landmark', 'heading', 'entry', 'push button', 'toggle button', 'list', 'list item', 'section', 'status', 'alert',
  ]);

  await (await session.find('main li button', { text: 'PR #47' })).click();
  await session.find('.prose h2');
  await sleep(500);
  dump('reader', ['article', 'heading', 'link', 'push button', 'paragraph', 'list', 'list item']);
} finally {
  await session.close();
  driver.stop();
}
