# -*- coding: utf-8 -*-
"""Shared Unicode normalisation helpers for CODESYS/IronPython scripts.

CODESYS scripting on Chinese Windows can hand POU text back as cp936/GBK
byte strings. Never decode those bytes with utf-8 + replace first: doing so
turns every GBK double-byte Chinese character into U+FFFD before JSON/base64
or UTF-8 file output has a chance to preserve it.
"""

try:
    unicode_type = unicode  # noqa: F821 -- IronPython/Python 2
except NameError:
    unicode_type = str

try:
    bytes_type = bytes
except NameError:
    bytes_type = str


def to_unicode_text(value):
    """Return *value* as Python unicode without lossy early replacement.

    Preferred chain for byte strings:
      utf-8 -> cp936 -> gbk -> cp1252 -> latin-1(replace)

    The final replace fallback is intentionally last. cp936/GBK is required for
    Chinese Windows CODESYS ScriptEngine text returned as bytes.
    """
    if value is None:
        return u""

    if isinstance(value, unicode_type):
        return value

    if isinstance(value, bytes_type):
        for enc in ("utf-8", "cp936", "gbk", "cp1252"):
            try:
                return value.decode(enc)
            except Exception:
                pass
        try:
            return value.decode("latin-1", "replace")
        except Exception:
            pass

    try:
        return unicode_type(value)
    except Exception:
        pass

    try:
        return unicode_type(repr(value))
    except Exception:
        return u""


def to_printable_text(value):
    """Alias used where a script only needs safe human-readable output."""
    return to_unicode_text(value)
