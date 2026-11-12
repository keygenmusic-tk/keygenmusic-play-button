import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtemp, mkdir, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';
import zl from 'zip-lib';

const scriptPath = fileURLToPath(new URL('../utils/create-zip.mjs', import.meta.url));
const createFixture = async t => {
    const cwd = await mkdtemp(path.join(tmpdir(), 'mv3-create-zip-'));
    t.after(() => rm(cwd, {recursive: true, force: true}));
    await mkdir(path.join(cwd, 'dist'));
    await writeFile(path.join(cwd, 'package.json'), JSON.stringify({name: 'test-extension', version: '1.0.0'}));
    await writeFile(path.join(cwd, 'dist/manifest.json'), '{"manifest_version":3}');
    return cwd;
};

const runScript = cwd => {
    const result = spawnSync(process.execPath, [scriptPath], {cwd, encoding: 'utf8', timeout: 10000});
    assert.equal(result.error, undefined);
    assert.equal(result.signal, null);
    return result;
};

test('successful packaging exits zero and creates a readable release ZIP', async t => {
    const cwd = await createFixture(t);
    const result = runScript(cwd);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Release zip created/);
    const extracted = path.join(cwd, 'extracted');
    await zl.extract(path.join(cwd, 'releases/test-extension-v1.0.0.zip'), extracted);
    assert.equal(await readFile(path.join(extracted, 'manifest.json'), 'utf8'), '{"manifest_version":3}');
});

test('archive failure exits nonzero and never reports success', async t => {
    const cwd = await createFixture(t);
    // A file occupying the output directory reliably causes an asynchronous ZIP failure.
    await writeFile(path.join(cwd, 'releases'), 'not a directory');
    const result = runScript(cwd);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /not a directory/);
    assert.doesNotMatch(result.stdout, /Release zip created/);
});
