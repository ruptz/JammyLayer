import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from './config.js';

const tokenFile = () => join(config.dataDir, 'tokens.json');

export async function load() {
  try {
    return JSON.parse(await readFile(tokenFile(), 'utf8'));
  } catch {
    return null;
  }
}

/** Write via temp file + rename so a crash mid-write can't leave a truncated token file. */
export async function save(data) {
  const target = tokenFile();
  await mkdir(config.dataDir, { recursive: true });
  const tmp = `${target}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  await rename(tmp, target);
}

export async function clear() {
  await save({});
}
