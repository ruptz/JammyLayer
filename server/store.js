import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from './config.js';

const filePath = (name) => join(config.dataDir, name);

async function readJson(name) {
  try {
    return JSON.parse(await readFile(filePath(name), 'utf8'));
  } catch {
    return null;
  }
}

/** Write via temp file + rename so a crash mid-write can't leave a truncated file. */
async function writeJson(name, data) {
  const target = filePath(name);
  await mkdir(config.dataDir, { recursive: true });
  const tmp = `${target}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  await rename(tmp, target);
}

export const load = () => readJson('tokens.json');
export const save = (data) => writeJson('tokens.json', data);
export const clear = () => save({});

/**
 * Only the desktop build writes these: a packaged app has no .env, so the client
 * credentials typed into the setup page are persisted here instead. The
 * container keeps taking its credentials from the environment.
 */
export const loadSettings = () => readJson('settings.json');
export const saveSettings = (data) => writeJson('settings.json', data);
