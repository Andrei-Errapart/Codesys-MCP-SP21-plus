import sys, scriptengine as script_engine, os, traceback, json

try:
    unicode_type = unicode
except NameError:
    unicode_type = str


def to_unicode_text(value):
    """Return a real unicode string before json.dumps sees CODESYS/.NET text.

    IronPython 2.7 can keep CODESYS ScriptEngine text properties as .NET
    System.String-like objects. If those objects reach json.dumps directly,
    some host/stdout paths can coerce non-ASCII characters through the process
    codepage first, producing '?' or U+FFFD before ensure_ascii=True has a
    chance to escape the original Han characters. Normalising every text field
    to Python unicode here keeps the JSON payload ASCII-on-the-wire while
    preserving the original UTF-16/Unicode content for JSON escaping.
    """
    if value is None:
        return u""
    if isinstance(value, unicode_type):
        return value
    try:
        return unicode_type(value)
    except (UnicodeDecodeError, TypeError, ValueError):
        pass
    try:
        return unicode_type(str(value), 'utf-8', 'replace')
    except (UnicodeDecodeError, TypeError, ValueError):
        return unicode_type(repr(value), 'utf-8', 'replace')


try:
    print("DEBUG: get_all_pou_code script: Project='%s'" % PROJECT_FILE_PATH)
    primary_project = ensure_project_open(PROJECT_FILE_PATH)
    project_name = os.path.basename(PROJECT_FILE_PATH)

    all_code = []

    def collect_code(obj, path_prefix):
        """Recursively collect code from all objects that have textual content."""
        obj_name = to_unicode_text(getattr(obj, 'get_name', lambda: '?')())
        current_path = u"%s/%s" % (path_prefix, obj_name) if path_prefix else obj_name

        entry = None

        # Check for textual declaration
        decl_text = u""
        if hasattr(obj, 'textual_declaration'):
            try:
                td = obj.textual_declaration
                if td and hasattr(td, 'text'):
                    decl_text = to_unicode_text(td.text)
            except Exception:
                pass

        # Check for textual implementation
        impl_text = u""
        if hasattr(obj, 'textual_implementation'):
            try:
                ti = obj.textual_implementation
                if ti and hasattr(ti, 'text'):
                    impl_text = to_unicode_text(ti.text)
            except Exception:
                pass

        if decl_text or impl_text:
            entry = {
                'path': current_path,
                'type': type(obj).__name__,
            }
            if decl_text:
                entry['declaration'] = decl_text
            if impl_text:
                entry['implementation'] = impl_text
            all_code.append(entry)

        # Recurse into children
        try:
            children = obj.get_children(False)
            for child in children:
                collect_code(child, current_path)
        except Exception:
            pass

    # Start from project root
    try:
        root_children = primary_project.get_children(False)
        for child in root_children:
            collect_code(child, u"")
    except Exception as e:
        print("WARN: Error traversing project tree: %s" % e)

    # ensure_ascii=True is the IronPython 2.7 default today, but spell it out:
    # the whole transport contract assumes non-ASCII (Chinese comments etc.)
    # rides as \uXXXX escapes through the watcher's stdout buffer, and any
    # future SP that flips the default to False would silently break the JS
    # JSON.parse on the receiving side.
    code_json = json.dumps(all_code, ensure_ascii=True)
    print("### ALL_POU_CODE_START ###")
    print(code_json)
    print("### ALL_POU_CODE_END ###")
    print("Total POUs with code: %d" % len(all_code))
    print("SCRIPT_SUCCESS: All POU code retrieved.")
    sys.exit(0)
except Exception as e:
    detailed_error = traceback.format_exc()
    error_message = "Error getting all POU code for project %s: %s\n%s" % (PROJECT_FILE_PATH, e, detailed_error)
    print(error_message)
    print("SCRIPT_ERROR: %s" % error_message)
    sys.exit(1)
