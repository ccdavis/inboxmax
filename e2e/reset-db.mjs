// Start the e2e server from an empty database, on any OS (the server's
// DATABASE_URL points here, relative to server/).
import { mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = fileURLToPath(new URL('../server/target/e2e/', import.meta.url));
mkdirSync(dir, { recursive: true });
for (const name of readdirSync(dir)) {
  if (name.startsWith('inboxmax.db')) rmSync(join(dir, name));
}
