const fs = require('fs');
const path = require('path');

const AUTH_DIR = path.join(__dirname, 'auth_info_baileys');

console.log("\n=======================================================");
console.log("🧹 RE-SINCRONIZACIÓN COMPLETA DE WHATSAPP (FRESH QR SCAN)");
console.log("=======================================================\n");

try {
    if (fs.existsSync(AUTH_DIR)) {
        fs.rmSync(AUTH_DIR, { recursive: true, force: true });
        console.log("✅ Sesión anterior eliminada correctamente (`auth_info_baileys`).");
    } else {
        console.log("ℹ️ No se encontró una sesión guardada previa.");
    }
} catch (e) {
    console.error("⚠️ Error al eliminar la carpeta de sesión:", e.message);
}

console.log("\n📲 Iniciando Gateway para generar nuevo Código QR...\n");

// Iniciar servidor principal
require('./index.js');
