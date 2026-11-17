import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile } from 'node:fs/promises';
const exec = promisify(execFile);
const run = async (args) =>
  (await exec('docker', args, { windowsHide: true, maxBuffer: 4 * 1024 * 1024 })).stdout.trim();
const info = JSON.parse(await run(['info', '--format', '{{json .}}']));
if (info.OSType !== 'linux') throw new Error('Docker must use Linux containers');
await run(['pull', 'node:24-bookworm-slim']);
const base = JSON.parse(await run(['image', 'inspect', 'node:24-bookworm-slim']));
const digest = base[0].RepoDigests.find((s) => /^node@sha256:[a-f0-9]{64}$/.test(s));
if (!digest) throw new Error('Cannot resolve immutable base image');
console.log('Building from ' + digest);
await run(['build', '--build-arg', 'BASE_IMAGE=' + digest, '--tag', 'chatds-sandbox:1', 'sandbox']);
const image = JSON.parse(await run(['image', 'inspect', 'chatds-sandbox:1']));
await mkdir('test-results', { recursive: true });
await writeFile(
  'test-results/sandbox-build.json',
  JSON.stringify(
    { base: digest, imageId: image[0].Id, createdAt: new Date().toISOString() },
    null,
    2,
  ),
);
console.log('Built ' + image[0].Id + '; now use the desktop Docker check.');
