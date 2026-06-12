import sys, scriptengine as script_engine, os, traceback

USER_NAME = "{USER_NAME}"

try:
    print("DEBUG: remove_project_user script: User='%s', Project='%s'" % (USER_NAME, PROJECT_FILE_PATH))
    primary_project = ensure_project_open(PROJECT_FILE_PATH)
    if not USER_NAME:
        raise ValueError("User name empty.")

    um = primary_project.user_management
    if um is None:
        raise RuntimeError("Project user management is not available.")

    user = um.users[USER_NAME]
    user.remove()
    primary_project.save()

    print("User: %s" % USER_NAME)
    print("SCRIPT_SUCCESS: Project user removed. Project saved.")
    sys.exit(0)
except Exception as e:
    detailed_error = traceback.format_exc()
    error_message = "Error removing project user '%s' in %s: %s\n%s" % (
        USER_NAME, PROJECT_FILE_PATH, e, detailed_error)
    print(error_message)
    print("SCRIPT_ERROR: %s" % error_message)
    sys.exit(1)
