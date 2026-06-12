import sys, scriptengine as script_engine, os, traceback

IMPORT_PATH = r"{IMPORT_PATH}"

try:
    print("DEBUG: import_native script: path='%s', Project='%s'" % (IMPORT_PATH, PROJECT_FILE_PATH))
    primary_project = ensure_project_open(PROJECT_FILE_PATH)
    if not IMPORT_PATH or not os.path.isfile(IMPORT_PATH):
        raise ValueError("Import file does not exist: %s" % IMPORT_PATH)

    result = primary_project.import_native(IMPORT_PATH)
    primary_project.save()
    print("DEBUG: import_native + save OK")

    # NativeImportResult exposes imported_objects on most SPs; best-effort.
    try:
        imported = list(getattr(result, 'imported_objects', None) or [])
        print("Imported Objects: %d" % len(imported))
        for obj in imported[:50]:
            print("  - %s" % getattr(obj, 'get_name', lambda: '?')())
    except Exception as e:
        print("DEBUG: could not enumerate import result: %s" % e)

    print("Import Path: %s" % IMPORT_PATH)
    print("SCRIPT_SUCCESS: Native import completed. Project saved.")
    sys.exit(0)
except Exception as e:
    detailed_error = traceback.format_exc()
    error_message = "Error importing native file into project %s: %s\n%s" % (PROJECT_FILE_PATH, e, detailed_error)
    print(error_message)
    print("SCRIPT_ERROR: %s" % error_message)
    sys.exit(1)
