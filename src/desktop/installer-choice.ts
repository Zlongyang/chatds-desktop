import { open, unlink } from 'node:fs/promises';
import { join } from 'node:path';

export type InstallerChoice = { action: 'download' } | { action: 'directory'; directory: string };

// NSIS writes this once, after the interactive installation completes. It carries
// only the user's installation choice, never a WebUI token or QQ account.
export async function takeInstallerChoice(userData: string): Promise<InstallerChoice | undefined> {
  const path = join(userData, 'napcat-setup.ini');
  const file = await open(path, 'r').catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error;
    return undefined;
  });
  if (!file) return;
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > 16384) return;
    const data = await file.readFile();
    const raw = data
      .toString(data[0] === 0xff && data[1] === 0xfe ? 'utf16le' : 'utf8')
      .replace(/^\uFEFF/, '');
    const lines = raw.split(/\r?\n/);
    if (lines[0] !== '[NapCat]') return;
    if (lines.includes('action=download')) return { action: 'download' };
    const directory = lines
      .find((line) => line.startsWith('directory='))
      ?.slice('directory='.length);
    if (lines.includes('action=directory') && directory) return { action: 'directory', directory };
  } finally {
    await file.close();
    await unlink(path);
  }
}
