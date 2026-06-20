import sys, scriptengine as script_engine, os, traceback
import base64

POU_FULL_PATH = "{POU_FULL_PATH}"
CODE_START_MARKER = "### POU CODE START ###"
CODE_END_MARKER = "### POU CODE END ###"
DECL_START_MARKER = "### POU DECLARATION START ###"
DECL_END_MARKER = "### POU DECLARATION END ###"
IMPL_START_MARKER = "### POU IMPLEMENTATION START ###"
IMPL_END_MARKER = "### POU IMPLEMENTATION END ###"
DECL_B64_START_MARKER = "### POU DECLARATION B64 START ###"
DECL_B64_END_MARKER = "### POU DECLARATION B64 END ###"
IMPL_B64_START_MARKER = "### POU IMPLEMENTATION B64 START ###"
IMPL_B64_END_MARKER = "### POU IMPLEMENTATION B64 END ###"

try:
    def to_b64_utf8(text):
        text = to_unicode_text(text)
        return base64.b64encode(text.encode("utf-8"))

    print("DEBUG: Getting code: POU_FULL_PATH='%s', Project='%s'" % (to_unicode_text(POU_FULL_PATH), to_unicode_text(PROJECT_FILE_PATH)))
    primary_project = ensure_project_open(PROJECT_FILE_PATH)
    if not POU_FULL_PATH: raise ValueError("POU full path empty.")

    # Find the target POU/Method/Property object
    target_object = find_object_by_path_robust(primary_project, POU_FULL_PATH, "target object")
    if not target_object: raise ValueError("Target object not found using path: %s" % to_unicode_text(POU_FULL_PATH))

    target_name = to_unicode_text(getattr(target_object, 'get_name', lambda: POU_FULL_PATH)())
    print("DEBUG: Found target object: %s" % target_name)

    declaration_code = u""; implementation_code = u""

    # --- Get Declaration Part ---
    if hasattr(target_object, 'textual_declaration'):
        decl_obj = target_object.textual_declaration
        if decl_obj and hasattr(decl_obj, 'text'):
            try:
                declaration_code = to_unicode_text(decl_obj.text)
                print("DEBUG: Got declaration text.")
            except Exception as decl_read_err:
                print("ERROR: Failed to read declaration text: %s" % to_unicode_text(decl_read_err))
                declaration_code = u"/* ERROR reading declaration: %s */" % to_unicode_text(decl_read_err)
        else:
            print("WARN: textual_declaration exists but is None or has no 'text' attribute.")
    else:
        print("WARN: No textual_declaration attribute.")

    # --- Get Implementation Part ---
    if hasattr(target_object, 'textual_implementation'):
        impl_obj = target_object.textual_implementation
        if impl_obj and hasattr(impl_obj, 'text'):
            try:
                implementation_code = to_unicode_text(impl_obj.text)
                print("DEBUG: Got implementation text.")
            except Exception as impl_read_err:
                print("ERROR: Failed to read implementation text: %s" % to_unicode_text(impl_read_err))
                implementation_code = u"/* ERROR reading implementation: %s */" % to_unicode_text(impl_read_err)
        else:
            print("WARN: textual_implementation exists but is None or has no 'text' attribute.")
    else:
        print("WARN: No textual_implementation attribute.")


    print("Code retrieved for: %s" % target_name)
    # Print declaration/implementation as base64(utf-8) so Python 2 output
    # capture never has to coerce non-ASCII into a byte str.
    print("\n" + DECL_B64_START_MARKER)
    print(to_b64_utf8(declaration_code))
    print(DECL_B64_END_MARKER + "\n")
    print(IMPL_B64_START_MARKER)
    print(to_b64_utf8(implementation_code))
    print(IMPL_B64_END_MARKER + "\n")

    # --- LEGACY MARKERS for backward compatibility if needed ---
    # Combine both for old marker format, adding a separator line
    # legacy_combined_code = declaration_code + "\n\n// Implementation\n" + implementation_code
    # print(CODE_START_MARKER); print(legacy_combined_code); print(CODE_END_MARKER)
    # --- END LEGACY ---

    print("SCRIPT_SUCCESS: Code retrieved.")
    sys.exit(0)
except Exception as e:
    detailed_error = to_unicode_text(traceback.format_exc())
    error_message = "Error getting code for object '%s' in project '%s': %s\n%s" % (
        to_unicode_text(POU_FULL_PATH), to_unicode_text(PROJECT_FILE_PATH), to_unicode_text(e), detailed_error)
    print(error_message)
    print("SCRIPT_ERROR: %s" % error_message)
    sys.exit(1)
