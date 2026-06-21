import sys, scriptengine as script_engine, os, traceback

try:
    print("DEBUG: get_project_info script: Project='%s'" % to_unicode_text(PROJECT_FILE_PATH))
    primary_project = ensure_project_open(PROJECT_FILE_PATH)

    info = primary_project.get_project_info()

    lines = ["### PROJECT_INFO_START ###"]
    for prop in ('company', 'title', 'version', 'author', 'description'):
        try:
            val = to_unicode_text(getattr(info, prop))
            lines.append("%s: %s" % (prop, val))
        except Exception as e:
            lines.append("%s: <unavailable: %s>" % (prop, to_unicode_text(e)))

    # Custom property dictionary (library properties etc.). The dictionary is
    # a .NET IDictionary in IronPython: .Keys property; fall back to keys().
    keys = []
    try:
        vals = info.values
        try:
            keys = list(vals.Keys)
        except Exception:
            keys = list(vals.keys())
    except Exception as e:
        lines.append("DEBUG: could not enumerate values dictionary: %s" % to_unicode_text(e))
    for k in keys:
        try:
            key_text = to_unicode_text(k)
            val_text = to_unicode_text(info.values[k])
            lines.append("values[%s]: %s" % (key_text, val_text))
        except Exception as e:
            lines.append("values[%s]: <unreadable: %s>" % (to_unicode_text(k), to_unicode_text(e)))
    lines.append("### PROJECT_INFO_END ###")
    lines.append("SCRIPT_SUCCESS: Project info read.")
    for line in lines:
        write_utf8_line(line)
    sys.stdout.flush()
    sys.exit(0)
except Exception as e:
    detailed_error = to_unicode_text(traceback.format_exc())
    error_message = "Error reading project info for %s: %s\n%s" % (
        to_unicode_text(PROJECT_FILE_PATH), to_unicode_text(e), detailed_error)
    print(error_message)
    print("SCRIPT_ERROR: %s" % error_message)
    sys.exit(1)
