const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { GATEWAY_STATE_DIR } = require('./lib/repoPaths');

const AUTH_DIR = process.env.SDK_AUTH_DIR || path.join(GATEWAY_STATE_DIR, 'auth_info_baileys');

function askConfirmation(question) {
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
    });

    return new Promise((resolve) => {
        rl.question(question, (answer) => {
            rl.close();
            resolve(answer.trim().toLowerCase());
        });
    });
}

// Modo no interactivo: `npm run reset -- --yes` (o SDK_RESET_NONINTERACTIVE=1)
// borra auth_info_baileys y SALE. NO arranca el gateway: el gateway ya corriendo
// (dev.sh up) regenera el QR solo. Antes el script hacía require('./index.js') y
// quedaba como daemon colgado (nunca salía), lo que rompía automatización.
const NONINTERACTIVE = process.argv.includes('--yes') || process.env.SDK_RESET_NONINTERACTIVE === '1';

async function main() {
    console.log("\n=======================================================");
    console.log("🧹 RE-SINCRONIZACIÓN COMPLETA DE WHATSAPP (FRESH QR SCAN)");
    console.log("=======================================================\n");

    if (!fs.existsSync(AUTH_DIR)) {
        console.log("ℹ️ No se encontró una sesión guardada previa (`auth_info_baileys`).");
        if (NONINTERACTIVE) {
            console.log("✅ Nada que borrar. Levanta el gateway (npm run dev / dev.sh up) para generar el QR.\n");
            return;
        }
        console.log("\n📲 Iniciando Gateway para generar nuevo Código QR...\n");
        require('./index.js');
        return;
    }

    if (NONINTERACTIVE) {
        try {
            fs.rmSync(AUTH_DIR, { recursive: true, force: true });
            console.log("✅ Sesión anterior eliminada (`auth_info_baileys`). El gateway regenera el QR al reconectar.\n");
        } catch (e) {
            console.error("⚠️ Error al eliminar la carpeta de sesión:", e.message);
            process.exit(1);
        }
        return;
    }

    const answer = await askConfirmation("⚠️ ¿Estás seguro de que deseas eliminar la sesión actual y escanear un nuevo QR? [y/N]: ");

    if (['y', 'yes', 's', 'si', 'sí'].includes(answer)) {
        try {
            fs.rmSync(AUTH_DIR, { recursive: true, force: true });
            console.log("✅ Sesión anterior eliminada correctamente (`auth_info_baileys`).");
        } catch (e) {
            console.error("⚠️ Error al eliminar la carpeta de sesión:", e.message);
        }
        console.log("\n📲 Iniciando Gateway para generar nuevo Código QR...\n");
        require('./index.js');
    } else {
        console.log("❌ Operación cancelada. La sesión actual NO fue eliminada.\n");
        process.exit(0);
    }
}

main();
