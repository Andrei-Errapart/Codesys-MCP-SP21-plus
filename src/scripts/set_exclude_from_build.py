import sys, scriptengine as script_engine, os, traceback

OBJECT_PATH = "{OBJECT_PATH}"
EXCLUDE = {EXCLUDE}

try:
    print("DEBUG: set_exclude_from_build script: Object='%s', Exclude=%s, Project='%s'" % (
        OBJECT_PATH, EXCLUDE, PROJECT_FILE_PATH))
    primary_project = ensure_project_open(PROJECT_FILE_PATH)
    if not OBJECT_PATH:
        raise ValueError("Object path empty.")

    target_object = find_object_by_path_robust(primary_project, OBJECT_PATH, "target object")
    if not target_object:
        raise ValueError("Object not found at path: %s" % OBJECT_PATH)
    obj_name = getattr(target_object, 'get_name', lambda: OBJECT_PATH)()

    try:
        if not target_object.exclude_from_build_is_valid:
            raise TypeError("exclude_from_build is not valid for object '%s' (type %s)." % (
                obj_name, type(target_object).__name__))
    except AttributeError:
        print("DEBUG: exclude_from_build_is_valid not available; trying setter directly.")

    target_object.exclude_from_build = EXCLUDE
    primary_project.save()

    effective = "unknown"
    try:
        effective = str(target_object.effectively_excluded_from_build)
    except Exception:
        pass

    print("Object: %s" % obj_name)
    print("Exclude From Build: %s" % EXCLUDE)
    print("Effectively Excluded: %s" % effective)
    print("SCRIPT_SUCCESS: exclude_from_build set. Project saved.")
    sys.exit(0)
except Exception as e:
    detailed_error = traceback.format_exc()
    error_message = "Error setting exclude_from_build for '%s' in project %s: %s\n%s" % (
        OBJECT_PATH, PROJECT_FILE_PATH, e, detailed_error)
    print(error_message)
    print("SCRIPT_ERROR: %s" % error_message)
    sys.exit(1)
