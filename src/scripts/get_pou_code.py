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

    write_utf8_line("DEBUG: Getting code: POU_FULL_PATH='%s', Project='%s'" % (
        to_unicode_text(POU_FULL_PATH), to_unicode_text(PROJECT_FILE_PATH)))
    primary_project = ensure_project_open(PROJECT_FILE_PATH)
    if not POU_FULL_PATH:
        raise ValueError("POU full path empty.")

    # Find the target POU/Method/Property object
    target_object = find_object_by_path_robust(primary_project, POU_FULL_PATH, "target object")
    if not target_object:
        raise ValueError("Target object not found using path: %s" % to_unicode_text(POU_FULL_PATH))

    target_name = to_unicode_text(getattr(target_object, 'get_name', lambda: POU_FULL_PATH)())
    write_utf8_line("DEBUG: Found target object: %s" % target_name)

    declaration_code = u""
    implementation_code = u""

    # --- Get Declaration Part ---
    if hasattr(target_object, 'textual_declaration'):
        decl_obj = target_object.textual_declaration
        if decl_obj and hasattr(decl_obj, 'text'):
            try:
                declaration_code = to_unicode_text(decl_obj.text)
                write_utf8_line("DEBUG: Got declaration text.")
            except Exception as decl_read_err:
                write_utf8_line("ERROR: Failed to read declaration text: %s" % to_unicode_text(decl_read_err))
                declaration_code = u"/* ERROR reading declaration: %s */" % to_unicode_text(decl_read_err)
        else:
            write_utf8_line("WARN: textual_declaration exists but is None or has no 'text' attribute.")
    else:
        write_utf8_line("WARN: No textual_declaration attribute.")

    # --- Get Implementation Part ---
    if hasattr(target_object, 'textual_implementation'):
        impl_obj = target_object.textual_implementation
        if impl_obj and hasattr(impl_obj, 'text'):
            try:
                implementation_code = to_unicode_text(impl_obj.text)
                write_utf8_line("DEBUG: Got implementation text.")
            except Exception as impl_read_err:
                write_utf8_line("ERROR: Failed to read implementation text: %s" % to_unicode_text(impl_read_err))
                implementation_code = u"/* ERROR reading implementation: %s */" % to_unicode_text(impl_read_err)
        else:
            write_utf8_line("WARN: textual_implementation exists but is None or has no 'text' attribute.")
    else:
        write_utf8_line("WARN: No textual_implementation attribute.")

    write_utf8_line("Code retrieved for: %s" % target_name)
    # Print declaration/implementation as base64(utf-8) so Python 2 output
    # capture never has to coerce non-ASCII into a byte str.
    write_utf8_line(DECL_B64_START_MARKER)
    write_utf8_line(to_b64_utf8(declaration_code))
    write_utf8_line(DECL_B64_END_MARKER)
    write_utf8_line(IMPL_B64_START_MARKER)
    write_utf8_line(to_b64_utf8(implementation_code))
    write_utf8_line(IMPL_B64_END_MARKER)

    # --- LEGACY MARKERS for backward compatibility if needed ---
    # Combine both for old marker format, adding a separator line
    # legacy_combined_code = declaration_code + "\n\n// Implementation\n" + implementation_code
    # write_utf8_line(CODE_START_MARKER); write_utf8_line(legacy_combined_code); write_utf8_line(CODE_END_MARKER)
    # --- END LEGACY ---

    write_utf8_line("SCRIPT_SUCCESS: Code retrieved.")
    sys.exit(0)
except Exception as e:
    detailed_error = to_unicode_text(traceback.format_exc())
    error_message = "Error getting code for object '%s' in project '%s': %s\n%s" % (
        to_unicode_text(POU_FULL_PATH), to_unicode_text(PROJECT_FILE_PATH), to_unicode_text(e), detailed_error)
    write_utf8_line(error_message)
    write_utf8_line("SCRIPT_ERROR: %s" % error_message)
    sys.exit(1)
