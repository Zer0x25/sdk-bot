// 🧹 FASE 7: RESET LIMPIO (factory reset) — CLI.
// `npm run clean`: detiene las instancias (gateway + brain si corren),
// borra TODO el estado de runtime (la app queda como recién clonada; los
// perfiles SOUL se conservan) y relanza lo que estaba corriendo.
// Diferente de `npm run reset` (solo borra auth_info_baileys).
// Exige DOBLE confirmación (y/N + escribir BORRAR-TODO).
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { spawn } = require('child_process');
const { getStatePaths, performFactoryReset, lockFiles } = require('./services/factoryReset');

const BRAIN_DIR = path.join(__dirname, '..', 'brain');

function isProcessAlive(pid) {
    if (!pid) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch (e) {
        return e.code === 'EPERM';
    }
}

function readLock(file) {
    try {
        return parseInt(fs.readFileSync(file, 'utf8').trim(), 10);
    } catch (e) {
        return null;
    }
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// ¿El proceso vive bajo systemd? (cgroup lo delata) — si sí, al matarlo el
// service se relanza solo con Restart=always; no hay que relanzar a mano.
function isSystemdManaged(pid) {
    try {
        return fs.readFileSync(`/proc/${pid}/cgroup`, 'utf8').includes('systemd');
    } catch (e) {
        return false;
    }
}

// SIGTERM → espera 5s → SIGKILL. Devuelve true si era de systemd.
async function stopProcess(pid, name) {
    const systemd = isSystemdManaged(pid);
    console.log(`🛑 Deteniendo ${name} (PID ${pid})${systemd ? ' — service de systemd lo relanzará al terminar' : ''}...`);
    try { process.kill(pid, 'SIGTERM'); } catch (e) { /* ya muerto */ }
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && isProcessAlive(pid)) await sleep(200);
    if (isProcessAlive(pid)) {
        console.log(`⚠️  ${name} no cerró a tiempo (PID ${pid}); forzando SIGKILL...`);
        try { process.kill(pid, 'SIGKILL'); } catch (e) { /* ya muerto */ }
        await sleep(300);
    }
    return systemd;
}

function spawnBrain() {
    const venvPy = path.join(BRAIN_DIR, 'venv', 'bin', 'python');
    const py = fs.existsSync(venvPy) ? venvPy : 'python3';
    // Mismo estándar que los .service y el internalBus: BRAIN_PORT=5100 (fallback 5100).
    // Sin esto el brain hijo caía en el default 8000 y se desalineaba del gateway.
    const env = { ...process.env, BRAIN_PORT: process.env.BRAIN_PORT || 5100, BRAIN_HOST: process.env.BRAIN_HOST || '0.0.0.0' };
    const child = spawn(py, ['main.py'], { cwd: BRAIN_DIR, env, detached: true, stdio: 'ignore' });
    child.unref();
    console.log(`🧠 Brain relanzado (${py} main.py) en :${env.BRAIN_PORT} — espera unos segundos antes de preguntarle al gateway.`);
}

// Modo no interactivo: `npm run clean -- --yes` (o SDK_CLEAN_NONINTERACTIVE=1).
// Borra TODO el estado de runtime y SALE (no relanza nada: el gateway ya
// corriendo regenera el QR; dev.sh up es quien levanta). Antes el script
// relanzaba procesos y quedaba colgado como daemon.
const NONINTERACTIVE = process.argv.includes('--yes') || process.env.SDK_CLEAN_NONINTERACTIVE === '1';

function askConfirmation(question) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise(resolve => {
        rl.question(question, answer => {
            rl.close();
            resolve(answer.trim().toLowerCase());
        });
    });
}

async function main() {
    console.log('\n===========================================================');
    console.log('🧨 RESET LIMPIO (FACTORY RESET) — la app queda como recién clonada');
    console.log('===========================================================\n');
    console.log('Se borrará TODO el estado de runtime:');
    for (const entry of getStatePaths()) {
        console.log(`   • ${entry.label}${fs.existsSync(entry.path) ? '' : ' (no existe)'}`);
    }
    console.log('\n⚠️  Los perfiles SOUL (brain/profiles/*.md) se CONSERVAN (versionados en git).\n');

    if (NONINTERACTIVE) {
        console.log('🤖 Modo no interactivo (--yes): sin confirmaciones.\n');
    } else {
        const first = await askConfirmation('¿Continuar? [y/N]: ');
        if (!['y', 'yes', 's', 'si', 'sí'].includes(first)) {
            console.log('❌ Operación cancelada. Nada fue borrado.');
            process.exit(0);
        }

        const magic = await askConfirmation('⚠️  CONFIRMACIÓN FINAL: escribe BORRAR-TODO para continuar: ');
        if (magic !== 'borrar-todo') {
            console.log('❌ Confirmación incorrecta. Nada fue borrado.');
            process.exit(0);
        }
    }

    // 1) Parar instancias (el lock de instancia única protege auth_info_baileys)
    const locks = lockFiles();
    const gwPid = readLock(locks.gateway);
    const brainPid = readLock(locks.brain);
    let gwSystemd = false;
    let brainSystemd = false;
    if (gwPid && isProcessAlive(gwPid)) gwSystemd = await stopProcess(gwPid, 'el gateway');
    if (brainPid && isProcessAlive(brainPid)) brainSystemd = await stopProcess(brainPid, 'el brain');

    // 2) Borrar TODO
    console.log('\n🧹 Borrando estado...');
    const report = performFactoryReset();
    for (const label of report.deleted) console.log(`   ✅ ${label}`);
    for (const label of report.missing) console.log(`   ➖ ${label} (no existía)`);
    if (report.errors.length > 0) {
        console.error('\n❌ ERRORES al borrar (aborta y NO relanza):');
        for (const e of report.errors) console.error(`   • ${e}`);
        process.exit(1);
    }
    console.log(`\n✅ Reset limpio completado (${report.deleted.length} borrados).`);

    // 3) Relanzar lo que estaba corriendo (systemd ya lo hace solo).
    // En modo no interactivo NO relanzamos: dejamos que dev.sh up / el gateway
    // ya corriendo regeneren el QR. Salimos limpio para automatización.
    if (NONINTERACTIVE) {
        console.log('\n🎉 Reset limpio completado (modo --yes). La app quedó en estado 0.');
        console.log('   Levanta con: bash deploy/linux/dev.sh up  (o el gateway ya corriendo regenera el QR).');
        process.exit(0);
    }

    if (brainPid && !brainSystemd) spawnBrain();
    if (gwPid && !gwSystemd) {
        console.log('🚀 Lanzando gateway para generar el QR nuevo (igual que `npm run reset`)...');
        require('./index.js');
        return; // el gateway toma el proceso; no salir
    }
    if (gwSystemd || brainSystemd) {
        console.log('♻️  Los services de systemd relanzan solos al terminar este script (Restart=always).');
        console.log('   Verifica con: systemctl --user status sdk-bot-{brain,gateway}');
    }
    console.log('\n🎉 La app quedó en estado 0: sesión nueva (QR/pairing), agenda vacía, default ignored_all.');
}

main();