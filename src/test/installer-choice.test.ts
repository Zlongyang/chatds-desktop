import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { takeInstallerChoice } from '../desktop/installer-choice.js';
import { temporary, removeTemporary } from './helpers.js';

test('the Windows installer handoff preserves a Unicode directory and is consumed once', async (t) => {
  const profile = temporary();
  t.after(() => removeTemporary(profile));
  const directory = 'D:\\小鱼 测试\\NapCat=Shell';
  await writeFile(
    join(profile, 'napcat-setup.ini'),
    '\uFEFF[NapCat]\r\naction=directory\r\ndirectory=' + directory + '\r\n',
    'utf16le',
  );
  assert.deepEqual(await takeInstallerChoice(profile), { action: 'directory', directory });
  assert.equal(await takeInstallerChoice(profile), undefined);
});

test('only a recognized installer choice starts setup', async (t) => {
  const profile = temporary();
  t.after(() => removeTemporary(profile));
  const handoff = join(profile, 'napcat-setup.ini');
  await writeFile(handoff, '[NapCat]\naction=download\n');
  assert.deepEqual(await takeInstallerChoice(profile), { action: 'download' });
  for (const invalid of [
    '[Other]\naction=download',
    '[NapCat]\naction=directory\ndirectory=',
    '[NapCat]\naction=download\n' + 'x'.repeat(17000),
  ]) {
    await writeFile(handoff, invalid);
    assert.equal(await takeInstallerChoice(profile), undefined);
  }
});
