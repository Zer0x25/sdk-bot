const fs = require('node:fs');
const path = require('node:path');
const { performance } = require('node:perf_hooks');

class ResetGuardError extends Error {
    constructor(code, message) { super(message); this.code = code; }
}

function blocked(code, detail) {
    return new ResetGuardError(code, `${detail} Reset abortado antes de borrar. Detén los supervisores y las instancias antes de repetir.`);
}

/** Inspect the locked process, never a guessed/default service name. */
function inspectProcess(pid, entryFile, {
    kill = process.kill, readFile = fs.readFileSync, readlink = fs.readlinkSync, platform = process.platform
} = {}) {
    try { kill(pid, 0); } catch (error) {
        if (error.code === 'ESRCH') return null;
        throw blocked('RESET_INSPECTION_FAILED', 'No se puede comprobar el proceso.');
    }
    if (platform !== 'linux') {
        throw blocked('RESET_INSPECTION_UNSUPPORTED', 'La parada automática solo se verifica en Linux.');
    }
    try {
        const stat = readFile(`/proc/${pid}/stat`, 'utf8');
        const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
        if (['Z', 'X'].includes(fields[0])) return null; // no open resources
        if (!/^\d+$/.test(fields[19])) throw new Error('Invalid process identity');
        const cwd = readlink(`/proc/${pid}/cwd`);
        const args = readFile(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean);
        if (!args.slice(1).some(arg => path.resolve(cwd, arg) === entryFile)) {
            throw blocked('RESET_OWNER_MISMATCH', 'El PID del lock no corresponde a la entrada esperada.');
        }
        const cgroup = readFile(`/proc/${pid}/cgroup`, 'utf8');
        const rows = cgroup.trim().split('\n');
        if (!rows.length || !rows.every(row => /^\d+:[^:]*:\//.test(row))) throw new Error('Invalid cgroup');
        // Includes delegated user services and legacy v1 name=systemd hierarchies.
        // Conservatively refuse an enclosing service as well as the leaf unit.
        const supervised = rows.some(row => /(?:^|\/)[^/]*\.service(?:\/|$)|docker|kubepods|libpod/.test(row));
        return { startTime: fields[19], supervised };
    } catch (error) {
        if (error instanceof ResetGuardError) throw error;
        if (error.code === 'ENOENT') {
            try { kill(pid, 0); } catch (gone) { if (gone.code === 'ESRCH') return null; }
        }
        throw blocked('RESET_INSPECTION_FAILED', 'No se puede verificar identidad/supervisión del proceso.');
    }
}

/**
 * Preflight ALL owners before sending any signal. Dependencies permit a fake
 * supervisor in tests; the CLI never accepts a flag to bypass these checks.
 */
function createResetGuard(owners, {
    inspect = inspectProcess, readFile = fs.readFileSync, kill = process.kill,
    sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), now = () => performance.now(),
    stopTimeoutMs = 5000, killTimeoutMs = 1000, settleMs = 500, log = console.log
} = {}) {
    function readPid(owner) {
        let value;
        try { value = readFile(owner.lockFile, 'utf8').trim(); } catch (error) {
            if (error.code === 'ENOENT') return null;
            throw blocked('RESET_LOCK_UNREADABLE', `No se puede leer el lock de ${owner.name}.`);
        }
        const pid = Number(value);
        if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(pid) || pid <= 1 || pid === process.pid) {
            throw blocked('RESET_LOCK_INVALID', `El lock de ${owner.name} no contiene un PID seguro.`);
        }
        return pid;
    }

    function checkOwner(owner, pid) {
        const instance = inspect(pid, owner.entryFile);
        if (instance?.supervised) {
            throw blocked('RESET_SUPERVISOR_ACTIVE', `${owner.name} está bajo un servicio supervisado; no se enviará SIGTERM al PID.`);
        }
        return instance;
    }

    let snapshots;
    function current(original) {
        const instance = checkOwner(original.owner, original.pid);
        if (instance && instance.startTime !== original.instance.startTime) {
            throw blocked('RESET_PROCESS_REPLACED', `El PID de ${original.owner.name} fue reutilizado.`);
        }
        return instance;
    }

    async function waitStopped(original, timeoutMs) {
        const deadline = now() + timeoutMs;
        while (current(original)) {
            if (now() >= deadline) return false;
            await sleep(Math.min(100, Math.max(1, deadline - now())));
        }
        return true;
    }

    function signal(original, value) {
        if (!current(original)) return;
        try { kill(original.pid, value); } catch (error) {
            if (error.code !== 'ESRCH') throw blocked('RESET_STOP_FAILED', `No se pudo detener ${original.owner.name}.`);
        }
    }

    function assertQuiescent() {
        if (!snapshots) throw blocked('RESET_NOT_PREPARED', 'Falta la comprobación de parada.');
        for (const original of snapshots) {
            const pid = readPid(original.owner);
            if (pid !== null && pid !== original.pid) {
                throw blocked('RESET_PROCESS_REPLACED', `Apareció otro PID en el lock de ${original.owner.name}.`);
            }
            // A process can unlink its lock before its worker has actually closed.
            if (original.instance && current(original)) {
                throw blocked('RESET_PROCESS_ACTIVE', `${original.owner.name} sigue activo.`);
            }
            if (!original.instance && pid !== null && checkOwner(original.owner, pid)) {
                throw blocked('RESET_PROCESS_ACTIVE', `${original.owner.name} se inició durante la parada.`);
            }
        }
    }

    async function stop() {
        if (snapshots) throw blocked('RESET_ALREADY_PREPARED', 'La parada ya fue solicitada.');
        snapshots = owners.map(owner => {
            const pid = readPid(owner);
            return { owner, pid, instance: pid === null ? null : checkOwner(owner, pid) };
        });
        for (const original of snapshots) {
            if (!original.instance) continue;
            log(`🛑 Deteniendo ${original.owner.name} (PID ${original.pid})...`);
            signal(original, 'SIGTERM');
            if (!await waitStopped(original, stopTimeoutMs)) {
                log(`⚠️ ${original.owner.name} no cerró a tiempo; comprobando identidad antes de SIGKILL...`);
                signal(original, 'SIGKILL');
                if (!await waitStopped(original, killTimeoutMs)) {
                    throw blocked('RESET_PROCESS_ACTIVE', `${original.owner.name} no se detuvo tras SIGKILL.`);
                }
            }
        }
        await sleep(settleMs);
        assertQuiescent();
        return snapshots.filter(original => original.instance).map(original => original.owner.name);
    }

    return { stop, assertQuiescent };
}

module.exports = { createResetGuard, inspectProcess, ResetGuardError };
