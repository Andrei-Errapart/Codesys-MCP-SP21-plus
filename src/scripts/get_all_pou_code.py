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

    try:
        xml_text = xml_data.decode("utf-8")
    except Exception:
        xml_text = xml_data.decode("latin-1")

    result = {
        "source": "plcopen_xml_export",
        "xml": xml_text
    }

    code_json = json.dumps(result, ensure_ascii=True)

    print("### ALL_POU_CODE_START ###")
    print(code_json)
    print("### ALL_POU_CODE_END ###")
    print("SCRIPT_SUCCESS: Export-based POU retrieval completed.")
    sys.exit(0)

except Exception as e:
    detailed_error = to_unicode_text(traceback.format_exc())
    error_message = "Error exporting POU code for project %s: %s\n%s" % (
        to_unicode_text(PROJECT_FILE_PATH), to_unicode_text(e), detailed_error)
    print(error_message)
    print("SCRIPT_ERROR: %s" % error_message)
    sys.exit(1)
