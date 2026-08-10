"""Tests unitarios del parser de perfiles SOUL (brain/profiles.py).

Correr: venv/bin/python -m pytest tests/ (desde brain/).
Los tests usan fixtures en /tmp y restablecen el estado global del módulo.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


import profiles as P

PERFIL_COMPLETO = """# Lucía
Asistente comercial de la pizzería.

## Personalidad
Amable y cercana, habla chileno natural.

## Reglas
- Saludar siempre al inicio.
- No inventar precios.
* Responder en máx 3 mensajes.

## Formato
Respuestas cortas, sin emojis.

## Ejemplos
**Cliente:** ¿Cuánto cuesta la familiar?
**Asistente:** La familiar vale $12.990.
**Cliente:** ¿Hacen delivery?
**Asistente:** Sí, delivery gratis sobre $20.000.
"""


def test_parse_completo():
    p = P._parse_md(PERFIL_COMPLETO, "lucia")
    assert p["nombre"] == "Lucía"
    assert p["descripcion"] == "Asistente comercial de la pizzería."
    assert p["personalidad"] == "Amable y cercana, habla chileno natural."
    assert p["reglas"] == ["Saludar siempre al inicio.", "No inventar precios.", "Responder en máx 3 mensajes."]
    assert p["formato"] == "Respuestas cortas, sin emojis."
    assert p["ejemplos"] == [
        {"cliente": "¿Cuánto cuesta la familiar?", "asistente": "La familiar vale $12.990."},
        {"cliente": "¿Hacen delivery?", "asistente": "Sí, delivery gratis sobre $20.000."},
    ]


def test_parse_sin_titulo_nombre_desde_key():
    p = P._parse_md("## Reglas\n- Una regla\n", "mateo")
    assert p["nombre"] == "Mateo"
    assert p["reglas"] == ["Una regla"]
    assert p["descripcion"] == ""


def test_parse_sin_secciones():
    p = P._parse_md("Texto suelto sin secciones.", "x")
    assert p["descripcion"] == "Texto suelto sin secciones."
    assert p["reglas"] == []
    assert p["ejemplos"] == []
    assert p["personalidad"] == ""
    assert p["formato"] == ""


def test_parse_ignora_lineas_no_viñeta_en_reglas():
    p = P._parse_md("## Reglas\n- Regla uno\nPárrafo suelto no es regla\n* Regla dos\n", "k")
    assert p["reglas"] == ["Regla uno", "Regla dos"]


def test_parse_ejemplos_con_mas_texto():
    contenido = "## Ejemplos\nTexto introductorio.\n**Cliente:** a\n**Asistente:** b\n"
    p = P._parse_md(contenido, "k")
    assert p["ejemplos"] == [{"cliente": "a", "asistente": "b"}]


def test_valid_key():
    assert P._valid_key("default") is True
    assert P._valid_key("mi-perfil_2") is True
    assert P._valid_key("LUCIA") is False  # mayúsculas no
    assert P._valid_key("perfil.md") is False
    assert P._valid_key("../etc") is False
    assert P._valid_key("") is False
    assert P._valid_key(None) is False


def test_list_md_files_filtra_invalidos(monkeypatch, tmp_path):
    (tmp_path / "default.md").write_text("# Default\n", encoding="utf-8")
    (tmp_path / "lucia.md").write_text("# Lucía\n", encoding="utf-8")
    (tmp_path / "NOTA.txt").write_text("x", encoding="utf-8")
    (tmp_path / "MAYUS.md").write_text("x", encoding="utf-8")
    (tmp_path / "perfil.md.md").write_text("x", encoding="utf-8")
    monkeypatch.setattr(P, "PROFILES_DIR", str(tmp_path))
    found = P._list_md_files()
    assert set(found.keys()) == {"default", "lucia"}


def test_read_profile_fallo_vuelve_default(monkeypatch, tmp_path):
    roto = tmp_path / "roto.md"
    roto.write_text("# ok\n", encoding="utf-8")
    monkeypatch.setattr(P, "PROFILES_DIR", str(tmp_path))

    # Simular un archivo ilegible (permisos) para forzar el fallback
    os.chmod(roto, 0o000)
    try:
        p = P._read_profile(str(roto), "roto")
        assert p["nombre"] == "Roto"
        assert p["reglas"] == []
    finally:
        os.chmod(roto, 0o644)


def test_build_system_prompt_usa_default_si_key_no_existe(monkeypatch, tmp_path):
    (tmp_path / "default.md").write_text("# Default\nDesc.\n\n## Personalidad\nNeutral\n\n## Reglas\n- Regla A\n", encoding="utf-8")
    monkeypatch.setattr(P, "PROFILES_DIR", str(tmp_path))
    P.refresh_profiles()

    prompt = P.build_system_prompt("noexiste")
    assert "Eres Default" in prompt
    assert "Regla A" in prompt

    prompt2 = P.build_system_prompt("default")
    assert prompt == prompt2

    P._profiles_cache.clear()  # limpiar estado global entre tests
