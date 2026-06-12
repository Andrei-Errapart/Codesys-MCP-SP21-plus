import sys, scriptengine as script_engine, os, traceback

COMPACT = {COMPACT}

try:
    print("DEBUG: source_download script: compact=%s, Project='%s'" % (COMPACT, PROJECT_FILE_PATH))
    primary_project = ensure_project_open(PROJECT_FILE_PATH)

    online_app, target_app = ensure_online_connection(primary_project)
    app_name = getattr(target_app, 'get_name', lambda: "Unknown")()
    ensure_logged_in(online_app)

    online_device = online_app.get_online_device()
    done = False
    if hasattr(online_device, 'download_source'):
        try:
            online_device.download_source(COMPACT)
            print("DEBUG: online_device.download_source(bCompact=%s) OK" % COMPACT)
            done = True
        except Exception as e:
            print("DEBUG: online_device.download_source failed: %s" % e)
    if not done:
        # Fallback: application-level source_download (no compact option).
        online_app.source_download()
        print("DEBUG: online_app.source_download() OK (fallback)")

    print("Compact: %s" % COMPACT)
    print("Application: %s" % app_name)
    print("SCRIPT_SUCCESS: Source archive downloaded to device.")
    sys.exit(0)
except Exception as e:
    detailed_error = traceback.format_exc()
    error_message = "Error downloading source to device for project %s: %s\n%s" % (PROJECT_FILE_PATH, e, detailed_error)
    print(error_message)
    print("SCRIPT_ERROR: %s" % error_message)
    sys.exit(1)
