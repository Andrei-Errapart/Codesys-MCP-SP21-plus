import sys, scriptengine as script_engine, os, traceback, base64

EXPORT_PATH = os.path.join(os.path.dirname(PROJECT_FILE_PATH), "_pou_export.xml")
EXPORT_PATH_B64_START_MARKER = "### ALL_POU_CODE_EXPORT_PATH_B64_START ###"
EXPORT_PATH_B64_END_MARKER = "### ALL_POU_CODE_EXPORT_PATH_B64_END ###"

def to_b64_utf8(text):
    text = to_unicode_text(text)
    try:
        return base64.b64encode(text.encode("utf-8"))
    except Exception:
        return base64.b64encode(str(text))

try:
    write_utf8_line("DEBUG: get_all_pou_code (export-based): Project='%s'" % to_unicode_text(PROJECT_FILE_PATH))
    primary_project = ensure_project_open(PROJECT_FILE_PATH)

    # Determine objects to export (full project subtree)
    try:
        objects = list(primary_project.get_children(False))
    except Exception:
        objects = []

    if not objects:
        raise RuntimeError("No objects found for export.")

    write_utf8_line("DEBUG: exporting %d root objects via PLCopenXML" % len(objects))

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

    write_utf8_line("DEBUG: PLCopenXML exported to %s (%d bytes)" % (EXPORT_PATH, os.path.getsize(EXPORT_PATH)))

    # Keep the transport ASCII-only: return just the file path as
    # base64(utf-8), then let Node read the XML bytes from disk directly.
    write_utf8_line(EXPORT_PATH_B64_START_MARKER)
    write_utf8_line(to_b64_utf8(EXPORT_PATH))
    write_utf8_line(EXPORT_PATH_B64_END_MARKER)
    write_utf8_line("SCRIPT_SUCCESS: Export-based POU retrieval completed.")
    sys.stdout.flush()
    sys.exit(0)

except Exception as e:
    detailed_error = to_unicode_text(traceback.format_exc())
    error_message = "Error exporting POU code for project %s: %s\n%s" % (
        to_unicode_text(PROJECT_FILE_PATH), to_unicode_text(e), detailed_error)
    write_utf8_line(error_message)
    write_utf8_line("SCRIPT_ERROR: %s" % error_message)
    sys.exit(1)

