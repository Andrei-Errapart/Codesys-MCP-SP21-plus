import sys, scriptengine as script_engine, os, traceback

OBJECT_PATH = "{OBJECT_PATH}"

try:
    print("DEBUG: get_signature_crc script: Object='%s', Project='%s'" % (OBJECT_PATH, PROJECT_FILE_PATH))
    primary_project = ensure_project_open(PROJECT_FILE_PATH)
    if not OBJECT_PATH:
        raise ValueError("Object path empty.")

    target_object = find_object_by_path_robust(primary_project, OBJECT_PATH, "target POU")
    if not target_object:
        raise ValueError("Object not found at path: %s" % OBJECT_PATH)
    obj_name = getattr(target_object, 'get_name', lambda: OBJECT_PATH)()

    if not hasattr(target_object, 'get_signature_crc'):
        raise TypeError("Object '%s' does not support get_signature_crc()." % obj_name)

    # Needs a successful build first (compile_project). Parent application
    # is found automatically when omitted.
    crc = target_object.get_signature_crc()
    if crc is None:
        raise RuntimeError(
            "Signature CRC is None for '%s' -- the application probably has not been "
            "built yet. Run compile_project first." % obj_name)

    # CRC may be an IronPython long -- print with %s, never json.
    print("Object: %s" % obj_name)
    print("Signature CRC: %s" % crc)
    print("SCRIPT_SUCCESS: Signature CRC read.")
    sys.exit(0)
except Exception as e:
    detailed_error = traceback.format_exc()
    error_message = "Error reading signature CRC for '%s' in project %s: %s\n%s" % (
        OBJECT_PATH, PROJECT_FILE_PATH, e, detailed_error)
    print(error_message)
    print("SCRIPT_ERROR: %s" % error_message)
    sys.exit(1)
