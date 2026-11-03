import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';

const exec = promisify(execFile);
const root = new URL('../', import.meta.url);

test('all shipped locale names and descriptions fit Chrome Web Store metadata limits', async () => {
  for (const locale of await readdir(new URL('_locales/', root))) {
    const data = JSON.parse(await readFile(new URL(`_locales/${locale}/messages.json`, root), 'utf8'));
    assert.ok([...data.extensionName.message].length <= 75, `${locale}: name exceeds 75 characters`);
    assert.ok([...data.extensionDescription.message].length <= 132, `${locale}: description exceeds 132 characters`);
  }
});

test('distribution ZIP includes extension files and excludes every translated README and developer directory', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'browsa-package-test-'));
  try {
    await mkdir(join(dir, 'build'));
    await copyFile(new URL('build/package.mjs', root), join(dir, 'build/package.mjs'));
    await writeFile(join(dir, 'package.json'), JSON.stringify({ version: '0.42.0' }));
    await writeFile(join(dir, 'manifest.json'), JSON.stringify({ version: '0.42.0', key: 'test-install-key' }));
    await writeFile(join(dir, 'sidepanel.js'), 'export const ready = true;');
    await writeFile(join(dir, 'LICENSE'), 'MIT');
    for (const name of ['README.md', 'README.en.md', 'README.ja.md', 'README.ko.md', 'README.es.md', 'README.pt-BR.md', 'README.ru.md']) {
      await writeFile(join(dir, name), 'Developer documentation');
    }
    await mkdir(join(dir, '.agents'));
    await writeFile(join(dir, '.agents/local.txt'), 'Private developer fixture');
    await mkdir(join(dir, 'docs'));
    await writeFile(join(dir, 'docs/site.html'), 'Website fixture');
    // 失败构建可能在运行根内留下刮擦残留（历史 SRC=lib/_src）：打包器按 FS
    // 枚举 lib/，gitignore 挡不住它——残留绝不能进 zip。
    await mkdir(join(dir, 'lib/_src'), { recursive: true });
    await writeFile(join(dir, 'lib/_src/planted.cjs.js'), '// leftover CJS intermediate from a failed build');
    await exec(process.execPath, [join(dir, 'build/package.mjs')]);
    const { stdout } = await exec('python3', ['-c', 'import zipfile,json,sys; z=zipfile.ZipFile(sys.argv[1]); print(json.dumps({"names":z.namelist(),"manifest":json.loads(z.read("manifest.json")),"corrupt":z.testzip()}))', join(dir, 'browsa-v0.42.0.zip')]);
    const archive = JSON.parse(stdout);
    assert.deepEqual(archive.names.sort(), ['LICENSE', 'manifest.json', 'sidepanel.js'],
      'build scratch leftovers (lib/_src) must never ship');
    assert.equal(archive.manifest.version, '0.42.0');
    assert.equal(archive.manifest.key, undefined);
    assert.equal(archive.corrupt, null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
