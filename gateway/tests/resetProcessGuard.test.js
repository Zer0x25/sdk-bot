const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { createResetGuard, inspectProcess } = require('../services/resetProcessGuard');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdkbot-reset-guard-'));
const envPaths = {
    SDK_CONVERSATIONS_DB_PATH: 'conversations.db', SDK_AUTH_DIR: 'auth',
    SDK_CONTACTS_DB_PATH: 'contacts.json', SDK_SETTINGS_DB_PATH: 'settings.json',
    SDK_BROADCAST_DB_PATH: 'broadcast.json', SDK_MESSAGE_QUEUE_PATH: 'queue.jsonl',
    BRAIN_MEMORY_DB: 'memory.db', SDK_ADMIN_WEB_LOG_GATEWAY: 'gwlogs',
    SDK_ADMIN_WEB_LOG_BRAIN: 'brlogs', SDK_GATEWAY_LOCK_PATH: 'gateway.lock', SDK_BRAIN_LOCK_PATH: 'brain.lock'
};
for (const [key, value] of Object.entries(envPaths)) process.env[key] = path.join(dir, value);
const { resetStoppedRuntime, processOwners } = require('../reset-clean');
const { getStatePaths } = require('../services/factoryReset');
after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    for (const key of Object.keys(envPaths)) delete process.env[key];
});

function fixture() {
    fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir);
    for (const entry of getStatePaths()) {
        fs.mkdirSync(path.dirname(entry.path), { recursive: true });
        if (entry.kind === 'dir') { fs.mkdirSync(entry.path); fs.writeFileSync(path.join(entry.path, 'canary'), 'preserve'); }
        else fs.writeFileSync(entry.path, 'preserve');
    }
    const owners = processOwners();
    const processes = new Map(); const signals = [];
    let clock = 0;
    const options = {
        now: () => clock, log: () => {}, stopTimeoutMs: 200, killTimeoutMs: 200, settleMs: 100,
        inspect: pid => processes.get(pid) || null,
        kill: (pid, signal) => { signals.push([pid, signal]); processes.delete(pid); },
        sleep: async ms => { clock += ms; }
    };
    function start(index, pid, supervised = false) {
        fs.writeFileSync(owners[index].lockFile, String(pid));
        processes.set(pid, { startTime: String(pid) + ':original', supervised });
    }
    for (const owner of owners) fs.rmSync(owner.lockFile);
    return { owners, processes, signals, options, start, guard: () => createResetGuard(owners, options) };
}
function preserved() {
    for (const entry of getStatePaths()) {
        if (/Lock/.test(entry.label)) continue;
        const file = entry.kind === 'dir' ? path.join(entry.path, 'canary') : entry.path;
        assert.equal(fs.readFileSync(file, 'utf8'), 'preserve', entry.label);
    }
}

test('BUG-029: auto-restarting service aborts before any signal/wipe; offline retry removes state', async () => {
    const f = fixture(); f.start(0, 7001); f.start(1, 7002, true);
    let restarts = 0;
    // A PID-only stop reproduces the original race: the supervisor relaunches.
    f.options.kill = (pid, signal) => {
        f.signals.push([pid, signal]); f.processes.delete(pid);
        if (pid === 7002) { restarts++; f.start(1, 7003, true); }
    };
    f.options.kill(7002, 'SIGTERM');
    assert.equal(restarts, 1); assert.ok(f.processes.has(7003)); preserved();
    f.signals.length = 0;
    await assert.rejects(resetStoppedRuntime(f.guard()), { code: 'RESET_SUPERVISOR_ACTIVE' });
    assert.deepEqual(f.signals, [], 'preflight brain prevents even stopping manual gateway');
    assert.equal(restarts, 1); preserved();
    // Simulate the operator stopping the supervisor, not just its child PID.
    f.processes.clear();
    const { stopped, report } = await resetStoppedRuntime(f.guard());
    assert.deepEqual(stopped, []); assert.deepEqual(report.errors, []);
    for (const entry of getStatePaths()) {
        if (/Logs/.test(entry.label)) assert.deepEqual(fs.readdirSync(entry.path), []);
        else assert.equal(fs.existsSync(entry.path), false, entry.label);
    }
});

test('manual owners stop before deletion and only previously live owners qualify for restart', async () => {
    const f = fixture(); f.start(0, 7101); f.start(1, 7102);
    const { stopped, report } = await resetStoppedRuntime(f.guard());
    assert.deepEqual(f.signals, [[7101, 'SIGTERM'], [7102, 'SIGTERM']]);
    assert.deepEqual(stopped, ['el gateway', 'el brain']); assert.deepEqual(report.errors, []);
});

test('a replaced lock during the settling window aborts; new owner never receives a signal', async () => {
    const f = fixture(); f.start(0, 7201);
    f.options.sleep = async () => { f.start(0, 7202); };
    await assert.rejects(resetStoppedRuntime(f.guard()), { code: 'RESET_PROCESS_REPLACED' });
    assert.deepEqual(f.signals, [[7201, 'SIGTERM']]); assert.ok(f.processes.has(7202)); preserved();
});

test('a formerly absent owner starting during stop aborts without deletion', async () => {
    const f = fixture(); f.start(0, 7301);
    f.options.sleep = async () => { f.start(1, 7302); };
    await assert.rejects(resetStoppedRuntime(f.guard()), { code: 'RESET_PROCESS_REPLACED' }); preserved();
});

test('removing a lock does not prove exit while the original process is alive', async () => {
    const f = fixture(); f.start(0, 7401);
    f.options.kill = (pid, signal) => { f.signals.push([pid, signal]); fs.rmSync(f.owners[0].lockFile, { force: true }); };
    await assert.rejects(resetStoppedRuntime(f.guard()), { code: 'RESET_PROCESS_ACTIVE' });
    assert.deepEqual(f.signals, [[7401, 'SIGTERM'], [7401, 'SIGKILL']]); preserved();
});

test('SIGKILL escalation waits for verified exit; a failed kill preserves all state', async () => {
    const f = fixture(); f.start(0, 7501);
    f.options.kill = (pid, signal) => {
        f.signals.push([pid, signal]); if (signal === 'SIGKILL') f.processes.delete(pid);
    };
    assert.deepEqual((await resetStoppedRuntime(f.guard())).stopped, ['el gateway']);
    assert.deepEqual(f.signals, [[7501, 'SIGTERM'], [7501, 'SIGKILL']]);
    const failing = fixture(); failing.start(0, 7502);
    failing.options.kill = () => { throw Object.assign(new Error('fixture denied'), { code: 'EPERM' }); };
    await assert.rejects(resetStoppedRuntime(failing.guard()), { code: 'RESET_STOP_FAILED' }); preserved();
});

test('PID reuse after SIGTERM aborts before escalating against the replacement', async () => {
    const f = fixture(); f.start(0, 7601);
    f.options.kill = (pid, signal) => {
        f.signals.push([pid, signal]); f.processes.set(pid, { startTime: 'new-process', supervised: false });
    };
    await assert.rejects(resetStoppedRuntime(f.guard()), { code: 'RESET_PROCESS_REPLACED' });
    assert.deepEqual(f.signals, [[7601, 'SIGTERM']]); preserved();
});

test('invalid and unreadable locks fail closed before signaling other owners', async () => {
    for (const value of ['1', '0', '-12', '7007junk', '7007\n7008', '9007199254740992', String(process.pid), '']) {
        const f = fixture(); f.start(0, 7701); fs.writeFileSync(f.owners[1].lockFile, value);
        await assert.rejects(resetStoppedRuntime(f.guard()), { code: 'RESET_LOCK_INVALID' });
        assert.deepEqual(f.signals, []); preserved();
    }
    const f = fixture(); f.start(0, 7702);
    f.options.readFile = () => { throw Object.assign(new Error('fixture unreadable'), { code: 'EACCES' }); };
    await assert.rejects(resetStoppedRuntime(f.guard()), { code: 'RESET_LOCK_UNREADABLE' }); preserved();
});

test('final synchronous guard catches a late replacement after stop returned', async () => {
    const f = fixture(); f.start(0, 7801);
    const guard = f.guard(); await guard.stop(); f.start(0, 7802);
    assert.throws(() => guard.assertQuiescent(), { code: 'RESET_PROCESS_REPLACED' }); preserved();
});

function procFixture(cgroup = '0::/\n') {
    const stat = ['S', ...Array(18).fill('0'), '12345'].join(' ');
    return {
        platform: 'linux', kill: () => {}, readlink: () => '/fixture/gateway',
        readFile: file => {
            if (file.endsWith('/stat')) return `7000 (node (fixture)) ${stat}`;
            if (file.endsWith('/cmdline')) return '/usr/bin/node\0index.js\0';
            if (file.endsWith('/cgroup')) return cgroup;
            throw new Error('unexpected fixture path');
        }
    };
}

test('process inspection identifies system/user/legacy systemd and container cgroups', () => {
    for (const cgroup of [
        '0::/system.slice/sdk-bot-gateway.service\n',
        '0::/user.slice/user-1000.slice/user@1000.service/app.slice/custom.service\n',
        '1:name=systemd:/system.slice/custom.service\n2:cpu:/\n',
        '0::/docker/fixture\n', '0::/kubepods/pod1\n', '0::/machine.slice/libpod-fixture.scope\n'
    ]) assert.equal(inspectProcess(7000, '/fixture/gateway/index.js', procFixture(cgroup)).supervised, true);
    assert.deepEqual(inspectProcess(7000, '/fixture/gateway/index.js', procFixture()), { startTime: '12345', supervised: false });
});

test('inspection failure, wrong owner and unsupported live platform never degrade to manual mode', () => {
    const denied = { ...procFixture(), readFile: () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); } };
    assert.throws(() => inspectProcess(7000, '/fixture/gateway/index.js', denied), { code: 'RESET_INSPECTION_FAILED' });
    assert.throws(() => inspectProcess(7000, '/fixture/other.js', procFixture()), { code: 'RESET_OWNER_MISMATCH' });
    assert.throws(() => inspectProcess(7000, '/fixture/gateway/index.js', procFixture('')), { code: 'RESET_INSPECTION_FAILED' });
    assert.throws(() => inspectProcess(7000, '/fixture/gateway/index.js', { ...procFixture(), platform: 'win32' }), { code: 'RESET_INSPECTION_UNSUPPORTED' });
    assert.equal(inspectProcess(7000, '/fixture/gateway/index.js', {
        ...procFixture(), kill: () => { throw Object.assign(new Error('gone'), { code: 'ESRCH' }); }
    }), null);
});

test('CLI --yes returns failure without wiping or relaunching when supervisor preflight aborts', { timeout: 10000 }, async () => {
    const f = fixture(); f.start(0, 7901, true);
    const preload = path.join(dir, 'supervisor.cjs');
    fs.writeFileSync(preload, `const m=require('node:module');const load=m._load;
 m._load=function(request){const value=load.apply(this,arguments);
 if(request==='./services/resetProcessGuard')return {...value,createResetGuard:owners=>value.createResetGuard(owners,{
 inspect:()=>({startTime:'fixture',supervised:true}),kill:()=>{throw Error('MUST NOT SIGNAL');}})};
 return value;};`);
    const child = spawn(process.execPath, ['--require', preload, path.resolve(__dirname, '../reset-clean.js'), '--yes'], {
        cwd: dir, env: { ...process.env, SDK_BOT_TEST: '1' }, stdio: ['ignore', 'pipe', 'pipe']
    });
    let output = ''; child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { output += data; });
    assert.deepEqual(await once(child, 'exit'), [1, null]);
    assert.match(output, /Reset abortado antes de borrar/); assert.doesNotMatch(output, /completado|relanzado/); preserved();
});

test('CLI --yes with offline owners wipes only its temporary inventory and exits without relaunch', { timeout: 10000 }, async () => {
    fixture();
    const stranger = path.join(dir, 'unrelated.txt'); fs.writeFileSync(stranger, 'preserve');
    const child = spawn(process.execPath, [path.resolve(__dirname, '../reset-clean.js'), '--yes'], {
        cwd: dir, env: { ...process.env, SDK_BOT_TEST: '1' }, stdio: ['ignore', 'ignore', 'ignore']
    });
    assert.deepEqual(await once(child, 'exit'), [0, null]);
    assert.equal(fs.readFileSync(stranger, 'utf8'), 'preserve');
    for (const entry of getStatePaths()) {
        if (/Logs/.test(entry.label)) assert.deepEqual(fs.readdirSync(entry.path), []);
        else assert.equal(fs.existsSync(entry.path), false, entry.label);
    }
});

test('real Linux child closes SQLite before offline reset; no channel/provider is started', { timeout: 15000, skip: process.platform !== 'linux' }, async t => {
    fixture();
    for (const suffix of ['', '-wal', '-shm']) fs.rmSync(process.env.SDK_CONVERSATIONS_DB_PATH + suffix, { force: true });
    const entry = path.join(dir, 'writer.js');
    const lock = process.env.SDK_GATEWAY_LOCK_PATH;
    fs.writeFileSync(entry, `const fs=require('node:fs');
const {createArchive}=require(${JSON.stringify(path.resolve(__dirname, '../services/conversations'))});
const archive=createArchive();archive.ready.then(async()=>{
fs.writeFileSync(${JSON.stringify(lock)},String(process.pid));process.send(await archive.snapshot());});
process.on('SIGTERM',async()=>{await archive.close();fs.unlinkSync(${JSON.stringify(lock)});process.exit(0);});`);
    const child = spawn(process.execPath, [entry], { cwd: dir, env: process.env, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    t.after(async () => {
        if (child.exitCode === null && child.signalCode === null) { const done = once(child, 'exit'); child.kill('SIGKILL'); await done; }
    });
    const message = once(child, 'message'); const exited = once(child, 'exit');
    await Promise.race([message, exited.then(() => { throw new Error('fixture exited before readiness'); })]);
    assert.ok(fs.existsSync(process.env.SDK_CONVERSATIONS_DB_PATH));
    const owner = { name: 'fixture writer', entryFile: entry, lockFile: lock };
    const state = inspectProcess(child.pid, entry);
    // An enclosing service is deliberately refused even for a manual child.
    if (state.supervised) {
        await assert.rejects(resetStoppedRuntime(createResetGuard([owner])), { code: 'RESET_SUPERVISOR_ACTIVE' });
        t.diagnostic('host cgroup supervised; checked fail-closed branch'); return;
    }
    const { report } = await resetStoppedRuntime(createResetGuard([owner], { log: () => {} }));
    assert.deepEqual(await exited, [0, null]); assert.deepEqual(report.errors, []);
    for (const suffix of ['', '-wal', '-shm']) assert.equal(fs.existsSync(process.env.SDK_CONVERSATIONS_DB_PATH + suffix), false);
});
