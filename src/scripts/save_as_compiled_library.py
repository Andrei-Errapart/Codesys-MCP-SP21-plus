import sys, scriptengine as script_engine, os, traceback

DESTINATION = r"{DESTINATION}"

try:
    print("DEBUG: save_as_compiled_library script: dest='%s', Project='%s'" % (DESTINATION, PROJECT_FILE_PATH))
    primary_project = ensure_project_open(PROJECT_FILE_PATH)

    # Empty destination -> project path with .compiled_library extension.
    if DESTINATION:
        primary_project.save_as_compiled_library(DESTINATION)
    else:
        primary_project.save_as_compiled_library()

    effective = DESTINATION
    if not effective:
        # SP21 writes '<project>.compiled-library' (hyphen); the API docs say
        # '.compiled_library' (underscore). Check both.
        base, _ext = os.path.splitext(PROJECT_FILE_PATH)
        for ext in (".compiled-library", ".compiled_library"):
            if os.path.exists(base + ext):
                effective = base + ext
                break
        else:
            effective = base + ".compiled-library"
    exists_note = "yes" if os.path.exists(effective) else "not found at expected path (check CODESYS messages)"

    print("Destination: %s" % effective)
    print("File Exists: %s" % exists_note)
    print("SCRIPT_SUCCESS: Compiled library saved.")
    sys.exit(0)
except Exception as e:
    detailed_error = traceback.format_exc()
    error_message = "Error saving compiled library for project %s: %s\n%s" % (PROJECT_FILE_PATH, e, detailed_error)
    print(error_message)
    print("SCRIPT_ERROR: %s" % error_message)
    sys.exit(1)
