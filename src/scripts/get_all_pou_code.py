import sys, scriptengine as script_engine, os, traceback, json

EXPORT_PATH = os.path.join(os.path.dirname(PROJECT_FILE_PATH), "_pou_export.xml")

try:
    print("DEBUG: get_all_pou_code (export-based): Project='%s'" % to_unicode_text(PROJECT_FILE_PATH))
    primary_project = ensure_project_open(PROJECT_FILE_PATH)

    # Determine objects to export (full project subtree)
    try:
        objects = list(primary_project.get_children(False))
    except Exception:
        objects = []

    if not objects:
        raise RuntimeError("No objects found for export.")

    print("DEBUG: exporting %d root objects via PLCopenXML" % len(objects))

    # Export via CODESYS native serializer (avoids .text API corruption)
    try:
        primary_project.export_xml(
            objects=objects,
            reporter=None,
            path=EXPORT_PATH,
            recursive=True,
            export_folder_structure=True
        )
    except Exception as e:
        raise RuntimeError("export_xml failed: %s" % to_unicode_text(e))

    if not os.path.isfile(EXPORT_PATH):
        raise RuntimeError("Export file not created at %s" % EXPORT_PATH)

    print("DEBUG: PLCopenXML exported to %s (%d bytes)" % (EXPORT_PATH, os.path.getsize(EXPORT_PATH)))

    # Read raw XML (no ScriptEngine text layer involved anymore)
    f = open(EXPORT_PATH, "rb")
    xml_data = f.read()
    f.close()

    # CODESYS export_xml writes a UTF-8 BOM (EF BB BF). utf-8-sig drops it on
    # decode; the lstrip guards against double-BOM and the legacy fallback path.
    # IronPython 2.7's json.dumps has a buggy py_encode_basestring_ascii that
    # round-trips through s.decode('utf-8'); a leading U+FEFF makes it raise
    # 'ascii' codec can't encode character U+FEFF (BOM), losing the whole payload.
    try:
        xml_text = xml_data.decode("utf-8-sig")
    except Exception:
        xml_text = xml_data.decode("latin-1")
    if xml_text.startswith(u"\ufeff"):
        xml_text = xml_text[1:]

    result = {
        "source": "plcopen_xml_export",
        "xml": xml_text
    }

    # IronPython 2.7's json with ensure_ascii=True calls py_encode_basestring_ascii,
    # which round-trips unicode through s.decode('utf-8') and raises
    # UnicodeEncodeError on the first non-ASCII char (system default codec is
    # ascii). Workaround: serialise with ensure_ascii=False and write UTF-8 bytes
    # directly to stdout via sys.stdout.write so Windows console codepage doesn't
    # re-mangle the payload either. The receiving Node side reads stdout as UTF-8.
    code_json = json.dumps(result, ensure_ascii=False)
    if isinstance(code_json, unicode):
        code_json_bytes = code_json.encode("utf-8")
    else:
        code_json_bytes = code_json
    sys.stdout.write("### ALL_POU_CODE_START ###\n")
    sys.stdout.write(code_json_bytes)
    sys.stdout.write("\n### ALL_POU_CODE_END ###\n")
    sys.stdout.write("SCRIPT_SUCCESS: Export-based POU retrieval completed.\n")
    sys.stdout.flush()
    sys.exit(0)

except Exception as e:
    detailed_error = to_unicode_text(traceback.format_exc())
    error_message = "Error exporting POU code for project %s: %s\n%s" % (
        to_unicode_text(PROJECT_FILE_PATH), to_unicode_text(e), detailed_error)
    print(error_message)
    print("SCRIPT_ERROR: %s" % error_message)
    sys.exit(1)
