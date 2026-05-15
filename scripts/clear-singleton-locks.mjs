import fs from 'node:fs';
import path from 'node:path';

const dir = path.join(process.env.APPDATA || '', 'secondbrain');
for (const f of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
  try {
    fs.unlinkSync(path.join(dir, f));
  } catch {
    // lock file may not exist — that's fine
  }
}
console.log('[predev] singleton locks cleared');
