import sys, scriptengine as script_engine, os, traceback

TEXTLIST_PATH = "{TEXTLIST_PATH}"
IMPORT_FILE = r"{IMPORT_FILE}"

try:
    print("DEBUG: import_text_list_file script: TextList='%s', File='%s', Project='%s'" % (
        TEXTLIST_PATH, IMPORT_FILE, PROJECT_FILE_PATH))
    primary_project = ensure_project_open(PROJECT_FILE_PATH)
    if not TEXTLIST_PATH:
        raise ValueError("Text list path empty.")
    if not IMPORT_FILE or not os.path.isfile(IMPORT_FILE):
        raise ValueError("Import file does not exist: %s" % IMPORT_FILE)

    tl = find_object_by_path_robust(primary_project, TEXTLIST_PATH, "text list")
    if not tl:
        raise ValueError("Text list not found at path: %s" % TEXTLIST_PATH)
    if not (hasattr(tl, 'is_textlist') and tl.is_textlist):
        raise TypeError("Object at '%s' is not a text list." % TEXTLIST_PATH)

    tl.importfile(IMPORT_FILE)
    primary_project.save()

    print("Text List: %s" % TEXTLIST_PATH)
    print("Imported: %s" % IMPORT_FILE)
    print("SCRIPT_SUCCESS: Text list entries imported. Project saved.")
    sys.exit(0)
except Exception as e:
    detailed_error = traceback.format_exc()
    error_message = "Error importing text list file into '%s' in %s: %s\n%s" % (
        TEXTLIST_PATH, PROJECT_FILE_PATH, e, detailed_error)
    print(error_message)
    print("SCRIPT_ERROR: %s" % error_message)
    sys.exit(1)
