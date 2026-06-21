import sys, scriptengine as script_engine, os, traceback

# Lists the tasks in the project's Task Configuration: each task's name,
# best-effort properties, and its ordered POU call list. Read-only.

def _children(obj):
    try:
        return list(obj.get_children(False))
    except Exception:
        return []


def _name(obj):
    try:
        return to_unicode_text(obj.get_name())
    except Exception:
        return u""


def _is_task_config(obj):
    try:
        if getattr(obj, 'is_task_configuration', False):
            return True
    except Exception:
        pass
    return _name(obj) == "Task Configuration"


def find_task_config(project):
    queue = _children(project)
    seen = 0
    while queue and seen < 5000:
        obj = queue.pop(0)
        seen += 1
        if _is_task_config(obj):
            return obj
        queue.extend(_children(obj))
    return None


try:
    primary_project = ensure_project_open(PROJECT_FILE_PATH)
    tc = find_task_config(primary_project)
    if tc is None:
        raise ValueError("Task Configuration object not found in project.")

    lines = ["### TASKS_START ###", "Task Configuration: %s" % _name(tc)]
    tasks = _children(tc)
    if not tasks:
        lines.append("(no tasks)")
    for t in tasks:
        tname = _name(t)
        props = []
        for attr in ('priority', 'interval', 'cycle_time', 'task_type', 'type', 'watchdog_enabled'):
            try:
                if hasattr(t, attr):
                    val = getattr(t, attr)
                    if not callable(val):
                        props.append("%s=%s" % (attr, to_unicode_text(val)))
            except Exception:
                pass
        calls = []
        try:
            if hasattr(t, 'pous'):
                for p in t.pous:
                    calls.append(to_unicode_text(p))
            else:
                calls = ["<no pous collection>"]
        except Exception as pe:
            calls = ["<pous read error: %s>" % to_unicode_text(pe)]
        lines.append("")
        lines.append("Task: %s" % tname)
        if props:
            lines.append("  Props: %s" % ", ".join(props))
        lines.append("  POU calls (%d): %s" % (len(calls), ", ".join(calls) if calls else "(none)"))
    lines.append("### TASKS_END ###")
    lines.append("SCRIPT_SUCCESS: Listed tasks.")
    for line in lines:
        write_utf8_line(line)
    sys.stdout.flush()
    sys.exit(0)
except Exception as e:
    detailed_error = to_unicode_text(traceback.format_exc())
    error_message = "Error listing tasks: %s\n%s" % (to_unicode_text(e), detailed_error)
    print(error_message)
    print("SCRIPT_ERROR: %s" % error_message)
    sys.exit(1)
