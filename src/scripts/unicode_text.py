# -*- coding: utf-8 -*-
"""Shared Unicode normalisation helpers for CODESYS/IronPython scripts.

CODESYS scripting on Chinese Windows can hand POU text back as cp936/GBK
byte strings. Never decode those bytes with utf-8 + replace first: doing so
turns every GBK double-byte Chinese character into U+FFFD before JSON/base64
or UTF-8 file output has a chance to preserve it.

Equally, do not hard-code cp936 ahead of the machine's own codepage. Those
bytes were produced by CODESYS encoding text with the system ANSI codepage,
so that codepage is the only correct second guess. cp936 accepts most byte
pairs, so trying it first corrupts Western European text: 'Zaehler' spelled
with U+00E4 is the bytes 5A E4 68 6C 65 72, and cp936 happily consumes
E4 68 as one Chinese character.
"""

import sys

try:
    unicode_type = unicode  # noqa: F821 -- IronPython/Python 2
except NameError:
    unicode_type = str

try:
    bytes_type = bytes
except NameError:
    bytes_type = str


def _system_ansi_encoding():
    """Best guess at the ANSI codepage CODESYS used to encode byte strings.

    locale.getpreferredencoding() is the portable answer and works under
    IronPython 2.7. sys.getfilesystemencoding() is the fallback; on Windows
    Python 2 it reports 'mbcs', which is itself a usable codec name.
    """
    for getter in (
        lambda: __import__("locale").getpreferredencoding(False),
        lambda: sys.getfilesystemencoding(),
    ):
        try:
            enc = getter()
        except Exception:
            continue
        if enc and enc.lower() not in ("ascii", "us-ascii", "ansi_x3.4-1968"):
            return enc
    return None


def _decode_chain():
    """utf-8, then the system codepage, then the usual suspects.

    Built once at import time -- the codepage cannot change under us mid-run.
    """
    chain = ["utf-8"]
    ansi = _system_ansi_encoding()
    if ansi:
        chain.append(ansi)
    for enc in ("cp936", "gbk", "cp1252"):
        if enc.lower() not in [c.lower() for c in chain]:
            chain.append(enc)
    return chain


DECODE_CHAIN = _decode_chain()


def to_unicode_text(value):
    """Return *value* as Python unicode without lossy early replacement.

    Chain for byte strings:
      utf-8 -> <system ANSI codepage> -> cp936 -> gbk -> cp1252 -> latin-1(replace)

    The final replace fallback is intentionally last.
    """
    if value is None:
        return u""

    if isinstance(value, unicode_type):
        return value

    if isinstance(value, bytes_type):
        for enc in DECODE_CHAIN:
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


def _to_utf8_stdout_bytes(value):
    text = to_unicode_text(value)
    try:
        return text.encode("utf-8")
    except Exception:
        try:
            return unicode_type(repr(value)).encode("utf-8", "replace")
        except Exception:
            return b""


def write_utf8_stdout(value):
    data = _to_utf8_stdout_bytes(value)
    try:
        sys.stdout.write(data)
    except TypeError:
        try:
            sys.stdout.buffer.write(data)
        except Exception:
            sys.stdout.write(data.decode("utf-8", "replace"))
    return data


def write_utf8_line(value=u""):
    write_utf8_stdout(value)
    write_utf8_stdout(u"\n")
