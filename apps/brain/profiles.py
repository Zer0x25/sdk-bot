"""
Perfiles SOUL (Personalidades del Bot)

Cada perfil vive como un archivo Markdown individual en `brain/profiles/` por
defecto (p.ej. lucia.md, mateo.md). `SDK_BRAIN_STATE_DIR` cambia la raíz de
estado y `SDK_BRAIN_PROFILES_DIR` permite elegir una carpeta independiente. Se
parsea a estructura y se compila a un system prompt mediante
build_system_prompt().

Formato esperado de cada .md:

    # Nombre

    Descripción breve.

    ## Personalidad
    Texto libre de la personalidad.

    ## Reglas
    - Regla uno.
    - Regla dos.

    ## Formato
    Texto libre del formato de respuesta.

    ## Ejemplos
    **Cliente:** pregunta del cliente
    **Asistente:** respuesta del asistente

El brain relee los archivos automáticamente si cambian (cache por mtime),
así se pueden editar en caliente sin reiniciar.
"""

import os
import re

from config import BRAIN_STYLE_GLOBAL
from logging_setup import make_logger
from runtime_paths import BRAIN_STATE_DIR

log = make_logger("brain.perfiles")

PROFILES_DIR = os.environ.get("SDK_BRAIN_PROFILES_DIR") or os.path.join(
    str(BRAIN_STATE_DIR), "profiles"
)

# Cache: key -> (mtime, profile_dict)
_profiles_cache: dict = {}


# -------------------------------------------------------------
# PARSER DE MARKDOWN
# -------------------------------------------------------------

def _parse_md(content: str, profile_key: str) -> dict:
    """Convierte el contenido de un .md de perfil a estructura de datos."""
    lines = content.splitlines()

    nombre = profile_key.capitalize()
    descripcion = ""
    secciones = {}
    seccion_actual = None
    buffer = []
    ejemplos = []

    for line in lines:
        stripped = line.strip()

        if stripped.startswith("# "):
            nombre = stripped[2:].strip()
            continue

        if stripped.startswith("## "):
            if seccion_actual and buffer:
                secciones[seccion_actual] = "\n".join(buffer).strip()
            seccion_actual = stripped[3:].strip().lower()
            buffer = []
            # Las secciones "tono: <nombre>" se acumulan en un dict de tonos
            if seccion_actual.startswith("tono:"):
                tono_nombre = seccion_actual.split(":", 1)[1].strip()
                secciones.setdefault("_tonos", {})[tono_nombre] = ""
                seccion_actual = f"_tono_buf:{tono_nombre}"
            continue

        if seccion_actual is None:
            if stripped and not descripcion:
                descripcion = stripped
            continue

        if seccion_actual.startswith("_tono_buf:"):
            tono_nombre = seccion_actual.split(":", 1)[1]
            secciones["_tonos"][tono_nombre] += (stripped + "\n")
            continue

        buffer.append(stripped)

    if seccion_actual and buffer:
        secciones[seccion_actual] = "\n".join(buffer).strip()

    # Procesar ejemplos en pares Cliente/Asistente
    # (lookahead no-greedy: el asistente termina en el siguiente par o fin del texto)
    ejemplos_texto = secciones.get("ejemplos", "")
    for match in re.finditer(r"\*\*Cliente:\*\*\s*(.+?)\s*\n\*\*Asistente:\*\*\s*(.+?)(?=\n\*\*Cliente:\*\*|$)", ejemplos_texto, re.DOTALL):
        ejemplos.append({
            "cliente": match.group(1).strip(),
            "asistente": match.group(2).strip()
        })

    reglas = [
        r[2:].strip() for r in secciones.get("reglas", "").splitlines()
        if r.strip().startswith("- ") or r.strip().startswith("* ")
    ]

    return {
        "nombre": nombre,
        "descripcion": descripcion,
        "personalidad": secciones.get("personalidad", ""),
        "reglas": reglas,
        "formato": secciones.get("formato", ""),
        "ejemplos": ejemplos,
        "tonos": secciones.get("_tonos", {})
    }


def _valid_key(profile_key: str) -> bool:
    """Solo claves seguras: minúsculas, dígitos, guiones y guiones bajos."""
    return bool(re.fullmatch(r"[a-z0-9_\-]+", profile_key or ""))


def _file_for(key: str) -> str:
    return os.path.join(PROFILES_DIR, f"{key}.md")


def _list_md_files() -> dict:
    """key -> ruta de cada .md en la carpeta de perfiles."""
    found = {}
    if not os.path.isdir(PROFILES_DIR):
        return found
    for fname in sorted(os.listdir(PROFILES_DIR)):
        if fname.endswith(".md"):
            key = fname[:-3]
            if _valid_key(key):
                found[key] = os.path.join(PROFILES_DIR, fname)
    return found


def get_profiles() -> dict:
    """Dict de perfiles con recarga automática si algún .md cambió (mtime)."""
    files = _list_md_files()

    # Detectar archivos nuevos o eliminados
    if set(files.keys()) != set(_profiles_cache.keys()):
        _reload_all(files)
        return _profiles_cache

    # Recargar solo los archivos cuyo mtime cambió
    changed = False
    for key, path in files.items():
        mtime = os.path.getmtime(path)
        cached = _profiles_cache.get(key)
        if cached is None or cached[0] != mtime:
            _profiles_cache[key] = (mtime, _read_profile(path, key))
            changed = True

    if changed:
        log.info(f"[PERFILES] Recarga automatica: {len(_profiles_cache)} perfiles activos")

    return _profiles_cache


def _reload_all(files: dict) -> None:
    _profiles_cache.clear()
    for key, path in files.items():
        _profiles_cache[key] = (os.path.getmtime(path), _read_profile(path, key))
    log.info(f"[PERFILES] Cargados {len(_profiles_cache)} perfiles activos.")


def _read_profile(path: str, key: str) -> dict:
    try:
        with open(path, encoding="utf-8") as f:
            return _parse_md(f.read(), key)
    except Exception as e:
        log.info(f"⚠️ Error al leer perfil ({type(e).__name__}).")
        return {
            "nombre": key.capitalize(),
            "descripcion": "",
            "personalidad": "",
            "reglas": [],
            "formato": "",
            "ejemplos": []
        }


def refresh_profiles() -> None:
    """Fuerza la recarga completa de perfiles (POST /profiles/reload)."""
    _profiles_cache.clear()
    get_profiles()


def tono_texto_a_dict(texto: str) -> dict:
    """Parsea una sección '## Tono: x' (texto libre) a partes reutilizables.

    Formato esperado:
        <descripción (1ª línea)>
        - viñetas de personalidad
        Reglas: ...
        Formato: ...
    """
    lineas = [ln.strip() for ln in (texto or "").splitlines() if ln.strip()]
    desc = lineas[0] if lineas else ""
    personalidad_parts = []
    reglas = []
    formato = ""
    modo = "personalidad"
    for ln in lineas[1:]:
        low = ln.lower()
        if low.startswith("reglas:"):
            modo = "reglas"
            rest = ln[len("reglas:"):].strip()
            if rest:
                reglas.append(rest)
            continue
        if low.startswith("formato:"):
            modo = "formato"
            formato = ln[len("formato:"):].strip()
            continue
        if modo == "personalidad":
            personalidad_parts.append(ln)
        elif modo == "reglas":
            if ln.startswith("- ") or ln.startswith("* "):
                reglas.append(ln[2:].strip())
            else:
                reglas.append(ln)
        elif modo == "formato":
            formato = (formato + " " + ln).strip()
    return {
        "desc": desc,
        "personalidad": " ".join(personalidad_parts),
        "reglas": reglas,
        "formato": formato
    }


def build_system_prompt(profile_key: str) -> str:
    """Compila un perfil SOUL a un system prompt completo para los proveedores."""
    profile = get_profiles().get(profile_key)
    if not profile:
        profile = get_profiles().get("default")
    if not profile:
        return "Eres un asistente virtual amigable y profesional."
    profile = profile[1]  # (mtime, dict)

    # Tonos fusionados: si pidieron recepcion/mateo/cobranzas, usar ese tono
    # del perfil default como personalidad/reglas efectivas (sin romper fallback).
    tonos = profile.get("tonos", {})
    efectivo = profile
    if profile_key in tonos:
        tono_texto = tono_texto_a_dict(tonos[profile_key])
        efectivo = {
            "nombre": profile["nombre"],
            "descripcion": tono_texto.get("desc", profile["descripcion"]),
            "personalidad": tono_texto.get("personalidad", profile["personalidad"]),
            "reglas": tono_texto.get("reglas", profile["reglas"]),
            "formato": tono_texto.get("formato", profile["formato"]),
            "ejemplos": profile["ejemplos"],
            "tonos": tonos
        }

    lines = [
        f"Eres {efectivo['nombre']}. {efectivo['descripcion']}",
        "",
        f"Personalidad: {efectivo['personalidad']}",
        "",
        "Reglas de comportamiento:"
    ]
    lines.extend(f"- {regla}" for regla in efectivo["reglas"])

    lines.extend([
        "",
        f"Formato de respuesta: {efectivo['formato']}",
        "",
        "Ejemplos:"
    ])
    for ejemplo in efectivo["ejemplos"]:
        lines.append(f"Cliente: \"{ejemplo['cliente']}\"")
        lines.append(f"Asistente: \"{ejemplo['asistente']}\"")

    # Estilo global de "imitación humana": se inyecta SIEMPRE, encima del rol
    # del perfil, para que la voz sea consistente en todos los bots/clientes.
    if BRAIN_STYLE_GLOBAL.strip():
        lines.extend([
            "",
            "Estilo de comunicación (aplica siempre):",
            BRAIN_STYLE_GLOBAL.strip(),
        ])

    return "\n".join(lines)


def list_profiles() -> list:
    """Metadatos livianos de cada perfil para exponer en GET /profiles."""
    return [
        {
            "key": key,
            "nombre": data[1]["nombre"],
            "descripcion": data[1]["descripcion"]
        }
        for key, data in get_profiles().items()
    ]


def get_profile_file(profile_key: str):
    """Devuelve (contenido_crudo, nombre_archivo) del .md de un perfil, o (None, None)."""
    if not _valid_key(profile_key):
        return None, None
    path = _file_for(profile_key)
    if not os.path.isfile(path):
        return None, None
    with open(path, encoding="utf-8") as f:
        return f.read(), f"{profile_key}.md"


def delete_profile(profile_key: str) -> dict:
    """Elimina el archivo .md de un perfil. `default` es irremplazable (base del bot)."""
    if not _valid_key(profile_key):
        return {"success": False, "message": "Clave de perfil inválida (solo minúsculas, números, - y _)"}
    if profile_key == "default":
        return {"success": False, "message": "'default' es el perfil base del bot y no se puede borrar. Si quieres cambiarlo, sube un perfil.md nuevo con /update."}

    path = _file_for(profile_key)
    if not os.path.isfile(path):
        return {"success": False, "message": f"Perfil '{profile_key}' no existe"}

    os.remove(path)
    refresh_profiles()
    return {"success": True, "key": profile_key}


def import_profile(profile_key: str, content: str) -> dict:
    """Valida y guarda un perfil desde su contenido .md (crea o actualiza)."""
    if not _valid_key(profile_key):
        return {"success": False, "message": "Clave de perfil inválida (solo minúsculas, números, - y _)"}

    parsed = _parse_md(content, profile_key)

    # Validaciones mínimas para no pisar con basura
    if not parsed["personalidad"].strip():
        return {"success": False, "message": "Falta la sección '## Personalidad'"}
    if not parsed["reglas"]:
        return {"success": False, "message": "Falta la sección '## Reglas' con al menos una viñeta (- ...)"}

    path = _file_for(profile_key)
    os.makedirs(PROFILES_DIR, exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        f.write(content if content.endswith("\n") else content + "\n")

    refresh_profiles()
    return {
        "success": True,
        "key": profile_key,
        "nombre": parsed["nombre"],
        "reglas": len(parsed["reglas"]),
        "ejemplos": len(parsed["ejemplos"])
    }


# Cargar inicial
refresh_profiles()
