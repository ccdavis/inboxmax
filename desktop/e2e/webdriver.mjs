// A tiny W3C WebDriver client for tauri-driver, so the desktop tests need
// no npm dependencies.
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const ELEMENT = 'element-6066-11e4-a52e-4f735466cecf';

export async function startDriver({ port = 4444, env = {} } = {}) {
  const driver = spawn('tauri-driver', ['--port', String(port)], {
    env: { ...process.env, ...env },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try {
      await fetch(`${base}/status`);
      return { base, stop: () => driver.kill() };
    } catch {
      await sleep(100);
    }
  }
  driver.kill();
  throw new Error('tauri-driver did not start');
}

export class Session {
  static async create(base, application) {
    const value = await call(base, 'POST', '/session', {
      capabilities: { alwaysMatch: { 'tauri:options': { application } } },
    });
    return new Session(base, value.sessionId);
  }

  constructor(base, id) {
    this.base = base;
    this.id = id;
  }

  cmd(method, path, body) {
    return call(this.base, method, `/session/${this.id}${path}`, body);
  }

  /**
   * Wait for the first element matching a CSS selector whose text content
   * includes `text` (if given). Matching uses textContent because
   * WebKitWebDriver's rendered text skips visually truncated spans.
   */
  async find(selector, { text, timeout = 15000 } = {}) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const ref = await this.execute(
        `const [selector, text] = arguments;
         return [...document.querySelectorAll(selector)]
           .find((el) => text === null || el.textContent.includes(text)) ?? null;`,
        [selector, text ?? null],
      );
      if (ref) return new Element(this, ref[ELEMENT]);
      await sleep(150);
    }
    throw new Error(`Timed out waiting for ${selector}${text ? ` containing "${text}"` : ''}`);
  }

  execute(script, args = []) {
    return this.cmd('POST', '/execute/sync', { script, args });
  }

  async screenshot() {
    return Buffer.from(await this.cmd('GET', '/screenshot'), 'base64');
  }

  close() {
    return this.cmd('DELETE', '');
  }
}

class Element {
  constructor(session, id) {
    this.session = session;
    this.id = id;
  }

  click() {
    return this.session.cmd('POST', `/element/${this.id}/click`, {});
  }

  type(text) {
    return this.session.cmd('POST', `/element/${this.id}/value`, { text });
  }

  /** Reference for passing this element to `Session.execute`. */
  get ref() {
    return { [ELEMENT]: this.id };
  }

  text() {
    return this.session.execute('return arguments[0].textContent', [this.ref]);
  }

  attribute(name) {
    return this.session.cmd('GET', `/element/${this.id}/attribute/${name}`);
  }
}

async function call(base, method, path, body) {
  const response = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await response.json();
  if (!response.ok || json.value?.error) {
    throw new Error(`${method} ${path}: ${JSON.stringify(json.value)}`);
  }
  return json.value;
}
