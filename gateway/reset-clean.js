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
const { createResetGuard, ResetGuardError } = require('./services/resetProcessGuard');

const BRAIN_DIR = path.join(__dirname, '..', 'brain');

function processOwners() {
    const locks = lockFiles();
    return [
        { name: 'el gateway', lockFile: locks.gateway, entryFile: path.join(__dirname, 'index.js') },
        { name: 'el brain', lockFile: locks.brain, entryFile: path.join(BRAIN_DIR, 'main.py') }
    ];
}

async function resetStoppedRuntime(processGuard = createResetGuard(processOwners())) {
    const stopped = await processGuard.stop();
    // No await between the final check and deletion of the runtime inventory.
    processGuard.assertQuiescent();
    return { stopped, report: performFactoryReset() };
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
// Tras comprobar la parada borra el estado y SALE sin relanzar. Un supervisor
// activo o no verificable aborta antes del borrado, también con --yes.
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

    // Preflight gateway AND brain before signals. Supervised processes must be
    // stopped by their operator; killing a PID would permit automatic restart.
    const { stopped, report } = await resetStoppedRuntime();
    console.log('\n🧹 Resultado del borrado:');
    for (const label of report.deleted) console.log(`   ✅ ${label}`);
    for (const label of report.missing) console.log(`   ➖ ${label} (no existía)`);
    if (report.errors.length > 0) {
        console.error('\n❌ ERRORES al borrar (aborta y NO relanza):');
        for (const e of report.errors) console.error(`   • ${e}`);
        process.exit(1);
    }
    console.log(`\n✅ Reset limpio completado (${report.deleted.length} borrados).`);

    // Relanzar solo instancias manuales que se comprobaron vivas y se detuvieron.
    // --yes sale sin iniciar ningún proceso.
    if (NONINTERACTIVE) {
        console.log('\n🎉 Reset limpio completado (modo --yes). La app quedó en estado 0.');
        console.log('   Levanta con: bash deploy/linux/dev.sh up all (o inicia tu supervisor después del borrado).');
        process.exit(0);
    }

    if (stopped.includes('el brain')) spawnBrain();
    if (stopped.includes('el gateway')) {
        console.log('🚀 Lanzando gateway para generar el QR nuevo (igual que `npm run reset`)...');
        require('./index.js');
        return; // el gateway toma el proceso; no salir
    }
    console.log('\n🎉 La app quedó en estado 0: sesión nueva (QR/pairing), agenda vacía, default ignored_all.');
}

if (require.main === module) {
    main().catch(error => {
        console.error(`\n❌ ${error instanceof ResetGuardError ? error.message : 'Falló el reset limpio.'}`);
        process.exitCode = 1;
    });
}

module.exports = { resetStoppedRuntime, processOwners };
