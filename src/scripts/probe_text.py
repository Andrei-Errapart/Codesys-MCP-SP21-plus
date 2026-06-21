# -*- coding: utf-8 -*-
import sys, traceback, scriptengine as script_engine

# Hidden diagnostic entrypoint
# Usage (from MCP layer): --probe-text <POU_PATH>

POU_PATH = "{POU_PATH}"

try:
    print("DEBUG: probe-text for POU = %s" % to_unicode_text(POU_PATH))

    primary_project = ensure_project_open(PROJECT_FILE_PATH)

    # Resolve POU object
    target = find_object_by_path_robust(primary_project, POU_PATH, "POU")
    if not target:
        raise RuntimeError("POU not found: %s" % to_unicode_text(POU_PATH))

    td = getattr(target, "textual_declaration", None)

    if td is None:
        raise RuntimeError("No textual_declaration on target")

    print("--- BASIC PYTHON VIEW ---")
    print("type(td): %s" % type(td))
    print("type(td.text): %s" % type(getattr(td, "text", None)))

    txt = getattr(td, "text", u"")

    print("len(td.text): %d" % len(txt))
    print("repr[:300]: %s" % repr(txt)[:300])

    bad = [hex(ord(c)) for c in txt if ord(c) > 127][:10]
    print("non-ascii sample ord(): %s" % bad)

    print("--- CLR REFLECTION LAYER ---")
    try:
        import clr
        clr_type = clr.GetClrType(type(td))
        prop = clr_type.GetProperty("Text")
        raw = prop.GetValue(td, None)

        print("clr raw type: %s" % type(raw))
        print("clr repr[:300]: %s" % repr(raw)[:300])
    except Exception as e:
        print("CLR probe failed: %s" % to_unicode_text(e))

    print("--- MEMBERS ---")
    print([m for m in dir(td) if "text" in m.lower() or "export" in m.lower()])

    print("SCRIPT_SUCCESS: probe complete")
    sys.exit(0)

except Exception as e:
    print("SCRIPT_ERROR: %s" % to_unicode_text(e))
    print(traceback.format_exc())
    sys.exit(1)
