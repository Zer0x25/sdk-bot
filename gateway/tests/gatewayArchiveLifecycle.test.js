const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { randomUUID } = require('node:crypto');
const { signContext, actorId } = require('../lib/panelContext');

test('gateway entry owns archive after process lock, honors configured lock path and closes durably on SIGTERM', { timeout: 20000 }, async t => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sdkbot-gateway-archive-'));
    const children = [];
    t.after(async () => {
        for (const child of children) if (child.exitCode === null && child.signalCode === null) {
            const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
        }
        await fs.rm(dir, { recursive: true, force: true });
    });
    const gateway = path.resolve(__dirname, '..');
    const preload = path.join(dir, 'offline.cjs');
    // Substitute transport connect only. Run real entry, DB worker, bus and exit.
    await fs.writeFile(preload, `
const Module=require('node:module');const path=require('node:path');const load=Module._load;
Module._load=function(request,parent,isMain){const value=load.apply(this,arguments);
 const resolved=Module._resolveFilename(request,parent);
 if(resolved===path.join(process.env.FIXTURE_GATEWAY,'adapters/whatsappAdapter.js'))value.prototype.connect=async function(){this.setStatus('standby','fixture_offline');};
 if(resolved===path.join(process.env.FIXTURE_GATEWAY,'services/internalBus.js')&&!value.fixtureWrapped){
  value.fixtureWrapped=true;const original=value.startInternalBus;
  value.startInternalBus=function(opts){const server=original(opts);server.once('listening',()=>process.send({port:server.address().port}));return server;};
 }return value;
};`);
    const contacts = path.join(dir, 'contacts.json'), settings = path.join(dir, 'settings.json');
    await fs.writeFile(contacts, '{}'); await fs.writeFile(settings, '{}');
    const secret = 'fixture-gateway-lifecycle-secret-32bytes';
    const lock = path.join(dir, 'locks/gateway.lock');
    const env = { ...process.env, NODE_ENV: 'development', NODE_OPTIONS: '--require=' + preload,
        FIXTURE_GATEWAY: gateway, SDK_BOT_TEST: '1', SDK_TEST_LOG_PATH: path.join(dir, 'gateway.log'),
        SDK_GATEWAY_LOCK_PATH: lock, SDK_CONVERSATIONS_DB_PATH: path.join(dir, 'archive.db'),
        SDK_AUTH_DIR: path.join(dir, 'auth'), SDK_CONTACTS_DB_PATH: contacts, SDK_SETTINGS_DB_PATH: settings,
        SDK_BROADCAST_DB_PATH: path.join(dir, 'broadcast.json'), SDK_MESSAGE_QUEUE_PATH: path.join(dir, 'queue.jsonl'),
        BRAIN_API_BASE: 'http://127.0.0.1:1', BRAIN_API_KEY: 'fixture-brain-key-no-network',
        STATUS_HOST: '127.0.0.1', STATUS_PORT: '0', INTERNAL_BUS_HOST: '127.0.0.1', INTERNAL_BUS_PORT: '0',
        SDK_PANEL_GATEWAY_SECRET: secret };
    const actor = { id: actorId('dev:lifecycle'), displayName: 'Fixture', capabilities: ['conversations:read'] };
    let snapshot;
    for (let cycle = 0; cycle < 2; cycle++) {
        const child = spawn(process.execPath, [path.join(gateway, 'index.js')], { cwd: dir, env, stdio: ['ignore','ignore','ignore','ipc'] });
        children.push(child);
        const [message] = await Promise.race([
            once(child, 'message'), once(child, 'exit').then(([code]) => { throw new Error(`Gateway fixture exited early: ${code}`); })
        ]);
        assert.equal(await fs.readFile(lock, 'utf8'), String(child.pid));
        const headers = signContext({ secret, actor, requestId: randomUUID(), method: 'GET', target: '/v1/session', body: Buffer.alloc(0) });
        const res = await fetch(`http://127.0.0.1:${message.port}/v1/session`, { headers });
        assert.equal(res.status, 200);
        const body = await res.json();
        if (snapshot) assert.deepEqual(body.snapshot, snapshot); else snapshot = body.snapshot;
        const exited = once(child, 'exit'); child.kill('SIGTERM');
        assert.deepEqual(await exited, [0, null]);
        await assert.rejects(fs.stat(lock), { code: 'ENOENT' });
    }
    assert.equal(snapshot.seq, '0');
});

test('real gateway wires WA capture before legacy cache/automation and drains durable observations across restart', { timeout: 20000 }, async t => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sdkbot-gateway-wa-'));
    const gateway = path.resolve(__dirname, '..'), children = [];
    t.after(async () => {
        for (const child of children) if (child.exitCode === null && child.signalCode === null) {
            const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
        }
        await fs.rm(dir, { recursive: true, force: true });
    });
    const preload = path.join(dir, 'transport.cjs');
    // Substitute only Baileys' transport/auth. Real adapter, entry, SQLite,
    // event wiring, cache, paused legacy handler and shutdown remain active.
    await fs.writeFile(preload, `
const Module=require('node:module'),path=require('node:path'),{EventEmitter}=require('node:events');const load=Module._load;
Module._load=function(request,parent,isMain){const value=load.apply(this,arguments);
 if(request==='@whiskeysockets/baileys')return {...value,
  useMultiFileAuthState:async()=>({state:{creds:{registered:true}},saveCreds:async()=>{}}),
  default:()=>({user:{id:'100:3@s.whatsapp.net'},ev:new EventEmitter(),end(){},
   async sendPresenceUpdate(){},async profilePictureUrl(){return null;},async fetchStatus(){return [];},
   async sendMessage(){throw Error('Fixture forbids provider sends');}})};
 if(Module._resolveFilename(request,parent)===path.join(process.env.FIXTURE_GATEWAY,'adapters/whatsappAdapter.js')&&!value.fixtureWrapped){
  value.fixtureWrapped=true;const connect=value.prototype.connect;
  value.prototype.connect=async function(options){await connect.call(this,options);
   require(path.join(process.env.FIXTURE_GATEWAY,'config.js')).state.IS_BOT_PAUSED=true;
   this.sock.ev.emit('connection.update',{connection:'open'});
   this.sock.ev.emit('messages.upsert',{type:'notify',messages:[0,1,2].map(n=>({
    key:{id:'entry-'+n,remoteJid:'200@s.whatsapp.net',fromMe:false},
    messageTimestamp:'1792368000',message:{conversation:'fixture '+n}}))});
   await this.capture.idle();await new Promise(resolve=>setImmediate(resolve));
   process.send({diagnostics:await this.archive.diagnostics(),snapshot:await this.archive.snapshot(),
    cached:require(path.join(process.env.FIXTURE_GATEWAY,'store/chatStore.js')).getRecent('200@s.whatsapp.net').length});
  };
 }return value;
};`);
    const contacts = path.join(dir, 'contacts.json'), settings = path.join(dir, 'settings.json');
    await fs.writeFile(contacts, '{}'); await fs.writeFile(settings, '{}');
    const lock = path.join(dir, 'gateway.lock');
    const env = { ...process.env, NODE_ENV: 'development', NODE_OPTIONS: '--require=' + preload,
        FIXTURE_GATEWAY: gateway, SDK_BOT_TEST: '1', SDK_TEST_LOG_PATH: path.join(dir, 'gateway.log'),
        SDK_GATEWAY_LOCK_PATH: lock, SDK_CONVERSATIONS_DB_PATH: path.join(dir, 'archive.db'),
        SDK_AUTH_DIR: path.join(dir, 'auth'), SDK_CONTACTS_DB_PATH: contacts, SDK_SETTINGS_DB_PATH: settings,
        SDK_BROADCAST_DB_PATH: path.join(dir, 'broadcast.json'), SDK_MESSAGE_QUEUE_PATH: path.join(dir, 'queue.jsonl'),
        BRAIN_API_BASE: 'http://127.0.0.1:1', BRAIN_API_KEY: 'fixture-no-network',
        STATUS_HOST: '127.0.0.1', STATUS_PORT: '0', INTERNAL_BUS_HOST: '127.0.0.1', INTERNAL_BUS_PORT: '0',
        SDK_PANEL_GATEWAY_SECRET: 'fixture-real-wa-entry-secret-32bytes' };
    let snapshot;
    for (let cycle = 0; cycle < 2; cycle++) {
        const child = spawn(process.execPath, [path.join(gateway, 'index.js')], { cwd: dir, env, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
        children.push(child);
        const [result] = await Promise.race([once(child, 'message'), once(child, 'exit').then(([code]) => { throw new Error(`Capture entry exited: ${code}`); })]);
        assert.equal(result.diagnostics.messages, 3); assert.equal(result.diagnostics.events, 3);
        assert.equal(result.cached, 3); assert.equal(result.snapshot.seq, '3');
        if (snapshot) assert.deepEqual(result.snapshot, snapshot); else snapshot = result.snapshot;
        const exited = once(child, 'exit'); child.kill('SIGTERM');
        assert.deepEqual(await exited, [0, null]);
        await assert.rejects(fs.stat(lock), { code: 'ENOENT' });
    }
});
