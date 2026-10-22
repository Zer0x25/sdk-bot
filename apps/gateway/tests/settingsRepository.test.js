const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createJsonSettingsRepository } = require('../services/repositories/jsonSettingsRepository');

test('JSON settings repository creates defaults, reads BOM files, and writes snapshots', async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdkbot-settings-repo-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const file = path.join(dir, 'settings.json');
    const repository = createJsonSettingsRepository(file);
    const defaults = { globalMode: 'ignored_all' };

    assert.equal(repository.exists(), false);
    repository.saveSync(defaults);
    assert.equal(repository.exists(), true);
    assert.deepEqual(repository.load(), defaults);

    fs.writeFileSync(file, `\uFEFF${JSON.stringify({ telegramChatId: '555' })}`);
    assert.deepEqual(repository.load(), { telegramChatId: '555' });

    const updated = { ...defaults, telegramChatId: '777' };
    await repository.save(updated);
    assert.deepEqual(repository.load(), updated);
});
