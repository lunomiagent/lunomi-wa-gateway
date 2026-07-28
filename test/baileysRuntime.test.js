const test = require('node:test');
const assert = require('node:assert/strict');

const { createBaileysLoader } = require('../baileysRuntime');

test('shares one Baileys import across concurrent callers', async () => {
    let imports = 0;
    const runtime = { default: () => 'socket' };
    const load = createBaileysLoader(async () => {
        imports += 1;
        return runtime;
    });

    const [first, second] = await Promise.all([load(), load()]);

    assert.equal(imports, 1);
    assert.equal(first, runtime);
    assert.equal(second, runtime);
});

test('adds context to an import failure and retries on the next call', async () => {
    let imports = 0;
    const load = createBaileysLoader(async () => {
        imports += 1;
        if (imports === 1) throw new Error('module load failed');
        return { default: () => 'socket' };
    });

    await assert.rejects(load(), /Unable to load Baileys v7 runtime/);
    const runtime = await load();

    assert.equal(imports, 2);
    assert.equal(typeof runtime.default, 'function');
});
