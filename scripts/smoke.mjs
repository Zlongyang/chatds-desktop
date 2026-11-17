import { spawn, execFile } from 'node:child_process';
import { mkdtemp, readFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import electron from 'electron';
const data = await mkdtemp(join(tmpdir(), 'chatds-test-smoke-'));
await mkdir('test-results', { recursive: true });
const packaged = process.argv.includes('--packaged');
const report = resolve('test-results/' + (packaged ? 'smoke-packaged.json' : 'smoke.json'));
await rm(report, { force: true });
const env = {
  ...process.env,
  CHATDS_TEST_MODE: '1',
  CHATDS_TEST_DATA: data,
  CHATDS_SMOKE_REPORT: report,
};
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(
  packaged ? resolve('release/win-unpacked/ChatDS.exe') : electron,
  packaged ? [] : ['.'],
  { cwd: process.cwd(), env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
);
let output = '';
child.stdout.on('data', (b) => (output += b));
child.stderr.on('data', (b) => (output += b));
const timeout = setTimeout(() => {
  if (process.platform === 'win32')
    execFile(
      'taskkill.exe',
      ['/PID', String(child.pid), '/T', '/F'],
      { windowsHide: true },
      () => {},
    );
  else child.kill('SIGKILL');
}, 30000);
const code = await new Promise((resolve, reject) => {
  child.on('exit', resolve);
  child.on('error', reject);
});
clearTimeout(timeout);
if (code !== 0) throw new Error('Electron smoke failed: ' + output.slice(-6000));
const result = JSON.parse(await readFile(report, 'utf8'));
if (
  result.hasNode ||
  !result.hasApi ||
  !result.testMode ||
  result.memoryCount < 1 ||
  !result.history.some((m) => m.role === 'assistant') ||
  result.nav.length !== 6 ||
  result.pages.length !== 6 ||
  result.pages.some((p) => !p.visible)
)
  throw new Error('Smoke assertions failed: ' + JSON.stringify(result));
console.log(
  JSON.stringify({
    ok: true,
    packaged,
    data,
    report,
    screenshot: report + '.chat.png',
    messages: result.history.length,
    memories: result.memoryCount,
    pages: result.pages.length,
  }),
);
