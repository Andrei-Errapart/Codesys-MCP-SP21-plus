import sys, scriptengine as script_engine, os, traceback

try:
    print("DEBUG: get_compiler_version script: Project='%s'" % PROJECT_FILE_PATH)
    primary_project = ensure_project_open(PROJECT_FILE_PATH)

    if not hasattr(primary_project, 'get_compilerversion'):
        raise TypeError("get_compilerversion is not available on this SP (needs scripting API 4.2.0.0+).")
    version = primary_project.get_compilerversion()

    print("Compiler Version: %s" % version)
    print("SCRIPT_SUCCESS: Compiler version read.")
    sys.exit(0)
except Exception as e:
    detailed_error = traceback.format_exc()
    error_message = "Error reading compiler version for %s: %s\n%s" % (PROJECT_FILE_PATH, e, detailed_error)
    print(error_message)
    print("SCRIPT_ERROR: %s" % error_message)
    sys.exit(1)
