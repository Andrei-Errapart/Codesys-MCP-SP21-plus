import sys, scriptengine as script_engine, os, traceback

IMPORT_PATH = r"{IMPORT_PATH}"
IMPORT_FOLDER_STRUCTURE = {IMPORT_FOLDER_STRUCTURE}

try:
    print("DEBUG: import_plcopen_xml script: path='%s', folders=%s, Project='%s'" % (
        IMPORT_PATH, IMPORT_FOLDER_STRUCTURE, PROJECT_FILE_PATH))
    primary_project = ensure_project_open(PROJECT_FILE_PATH)
    if not IMPORT_PATH or not os.path.isfile(IMPORT_PATH):
        raise ValueError("Import file does not exist: %s" % IMPORT_PATH)

    primary_project.import_xml(IMPORT_PATH, None, IMPORT_FOLDER_STRUCTURE)
    primary_project.save()
    print("DEBUG: import_xml + save OK")

    print("Import Path: %s" % IMPORT_PATH)
    print("SCRIPT_SUCCESS: PLCopenXML imported into project top level. Project saved.")
    sys.exit(0)
except Exception as e:
    detailed_error = traceback.format_exc()
    error_message = "Error importing PLCopenXML into project %s: %s\n%s" % (PROJECT_FILE_PATH, e, detailed_error)
    print(error_message)
    print("SCRIPT_ERROR: %s" % error_message)
    sys.exit(1)
