import sys, scriptengine as script_engine, os, traceback

try:
    print("DEBUG: set_compiler_version_to_newest script: Project='%s'" % PROJECT_FILE_PATH)
    primary_project = ensure_project_open(PROJECT_FILE_PATH)

    if not hasattr(primary_project, 'set_compilerversion_to_newest'):
        raise TypeError("set_compilerversion_to_newest is not available on this SP (needs scripting API 4.2.0.0+).")

    before = "unknown"
    try:
        before = str(primary_project.get_compilerversion())
    except Exception:
        pass

    primary_project.set_compilerversion_to_newest()
    primary_project.save()

    after = "unknown"
    try:
        after = str(primary_project.get_compilerversion())
    except Exception:
        pass

    print("Compiler Version Before: %s" % before)
    print("Compiler Version After: %s" % after)
    print("SCRIPT_SUCCESS: Compiler version set to newest and project saved.")
    sys.exit(0)
except Exception as e:
    detailed_error = traceback.format_exc()
    error_message = "Error setting compiler version for %s: %s\n%s" % (PROJECT_FILE_PATH, e, detailed_error)
    print(error_message)
    print("SCRIPT_ERROR: %s" % error_message)
    sys.exit(1)
