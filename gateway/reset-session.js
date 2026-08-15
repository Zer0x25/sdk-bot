const fs = require('fs');
const path = require('path');
const readline = require('readline');

const AUTH_DIR = process.env.SDK_AUTH_DIR || path.join(__dirname, 'auth_info_baileys');

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

async function main() {
    console.log("\n=======================================================");
    console.log("🧹 RE-SINCRONIZACIÓN COMPLETA DE WHATSAPP (FRESH QR SCAN)");
    console.log("=======================================================\n");

    if (!fs.existsSync(AUTH_DIR)) {
        console.log("ℹ️ No se encontró una sesión guardada previa (`auth_info_baileys`).");
        console.log("\n📲 Iniciando Gateway para generar nuevo Código QR...\n");
        require('./index.js');
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
