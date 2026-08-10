"""
Perfiles SOUL (Personalidades del Bot)

Cada perfil vive como un archivo Markdown individual en la carpeta ./profiles/
(p.ej. lucia.md, mateo.md). Se parsea a estructura y se compila a un system
prompt completo mediante build_system_prompt().

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

PROFILES_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "profiles")

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
            continue

        if seccion_actual is None:
            if stripped and not descripcion:
                descripcion = stripped
            continue

        buffer.append(stripped)

    if seccion_actual and buffer:
        secciones[seccion_actual] = "\n".join(buffer).strip()

    # Procesar ejemplos en pares Cliente/Asistente
    ejemplos_texto = secciones.get("ejemplos", "")
    for match in re.finditer(r"\*\*Cliente:\*\*\s*(.+?)\s*\n\*\*Asistente:\*\*\s*(.+)", ejemplos_texto, re.S):
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
        "ejemplos": ejemplos
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
        print(f"[PERFILES] Recarga automatica: {len(_profiles_cache)} perfiles activos")

    return _profiles_cache


def _reload_all(files: dict) -> None:
    _profiles_cache.clear()
    for key, path in files.items():
        _profiles_cache[key] = (os.path.getmtime(path), _read_profile(path, key))
    print(f"[PERFILES] Cargados {len(_profiles_cache)} perfiles desde {PROFILES_DIR}")


def _read_profile(path: str, key: str) -> dict:
    try:
        with open(path, "r", encoding="utf-8") as f:
            return _parse_md(f.read(), key)
    except Exception as e:
        print(f"⚠️ Error al leer perfil {key}.md: {e}")
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


def build_system_prompt(profile_key: str) -> str:
    """Compila un perfil SOUL a un system prompt completo para los proveedores."""
    profile = get_profiles().get(profile_key)
    if not profile:
        profile = get_profiles().get("default")
    if not profile:
        return "Eres un asistente virtual amigable y profesional."
    profile = profile[1]  # (mtime, dict)

    lines = [
        f"Eres {profile['nombre']}. {profile['descripcion']}",
        "",
        f"Personalidad: {profile['personalidad']}",
        "",
        "Reglas de comportamiento:"
    ]
    lines.extend(f"- {regla}" for regla in profile["reglas"])

    lines.extend([
        "",
        f"Formato de respuesta: {profile['formato']}",
        "",
        "Ejemplos:"
    ])
    for ejemplo in profile["ejemplos"]:
        lines.append(f"Cliente: \"{ejemplo['cliente']}\"")
        lines.append(f"Asistente: \"{ejemplo['asistente']}\"")

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
    with open(path, "r", encoding="utf-8") as f:
        return f.read(), f"{profile_key}.md"


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
