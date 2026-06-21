import sys, scriptengine as script_engine, os, traceback
import base64
import binascii

POU_FULL_PATH = "{POU_FULL_PATH}" # Expecting format like "Application/MyPOU" or "Folder/SubFolder/MyPOU"
DECLARATION_CONTENT_B64 = "{DECLARATION_CONTENT_B64}"
IMPLEMENTATION_CONTENT_B64 = "{IMPLEMENTATION_CONTENT_B64}"
# Boolean flags from the TS wrapper. "True" if the caller passed the field,
# "False" if they omitted it. Empty string is a valid intentional value
# (e.g. "wipe declaration") and must not be conflated with "not provided".
SET_DECLARATION = {SET_DECLARATION}
SET_IMPLEMENTATION = {SET_IMPLEMENTATION}

try:
    def decode_b64_utf8(label, payload):
        if not payload:
            return u""
        try:
            raw = base64.b64decode(payload)
        except (TypeError, binascii.Error) as decode_err:
            raise ValueError(
                "Expected valid base64 string for %s. Base64 decode failed: %s"
                % (label, decode_err)
            )
        try:
            return raw.decode("utf-8")
        except UnicodeDecodeError as decode_err:
            raise ValueError(
                "Expected UTF-8 text for %s. UTF-8 decode failed: %s"
                % (label, decode_err)
            )

    declaration_content = decode_b64_utf8("declaration", DECLARATION_CONTENT_B64) if SET_DECLARATION else u""
    implementation_content = decode_b64_utf8("implementation", IMPLEMENTATION_CONTENT_B64) if SET_IMPLEMENTATION else u""

    write_utf8_line("DEBUG: set_pou_code script: POU_FULL_PATH='%s', Project='%s'" % (
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

    # --- Set Declaration Part ---
    declaration_updated = False
    if SET_DECLARATION:
        if hasattr(target_object, 'textual_declaration'):
            decl_obj = target_object.textual_declaration
            if decl_obj and hasattr(decl_obj, 'replace'):
                try:
                    write_utf8_line("DEBUG: Accessing textual_declaration...")
                    decl_obj.replace(declaration_content)
                    write_utf8_line("DEBUG: Set declaration text using replace().")
                    declaration_updated = True
                except Exception as decl_err:
                    write_utf8_line("ERROR: Failed to set declaration text: %s" % to_unicode_text(decl_err))
                    traceback.print_exc()
            else:
                write_utf8_line("WARN: Target '%s' textual_declaration attribute is None or does not have replace(). Skipping declaration update." % target_name)
        else:
            write_utf8_line("WARN: Target '%s' does not have textual_declaration attribute. Skipping declaration update." % target_name)
    else:
        write_utf8_line("DEBUG: Declaration not provided by caller (SET_DECLARATION=False). Skipping declaration update.")

    # --- Set Implementation Part ---
    implementation_updated = False
    if SET_IMPLEMENTATION:
        if hasattr(target_object, 'textual_implementation'):
            impl_obj = target_object.textual_implementation
            if impl_obj and hasattr(impl_obj, 'replace'):
                try:
                    write_utf8_line("DEBUG: Accessing textual_implementation...")
                    impl_obj.replace(implementation_content)
                    write_utf8_line("DEBUG: Set implementation text using replace().")
                    implementation_updated = True
                except Exception as impl_err:
                    write_utf8_line("ERROR: Failed to set implementation text: %s" % to_unicode_text(impl_err))
                    traceback.print_exc()
            else:
                write_utf8_line("WARN: Target '%s' textual_implementation attribute is None or does not have replace(). Skipping implementation update." % target_name)
        else:
            write_utf8_line("WARN: Target '%s' does not have textual_implementation attribute. Skipping implementation update." % target_name)
    else:
        write_utf8_line("DEBUG: Implementation not provided by caller (SET_IMPLEMENTATION=False). Skipping implementation update.")

    # --- SAVE THE PROJECT TO PERSIST THE CODE CHANGE ---
    # Only save if something was actually updated to avoid unnecessary saves
    if declaration_updated or implementation_updated:
        try:
            write_utf8_line("DEBUG: Saving Project (after code change)...")
            primary_project.save() # Save the overall project file
            write_utf8_line("DEBUG: Project saved successfully after code change.")
        except Exception as save_err:
            write_utf8_line("ERROR: Failed to save Project after setting code: %s" % to_unicode_text(save_err))
            detailed_error = to_unicode_text(traceback.format_exc())
            error_message = "Error saving Project after code change for '%s': %s\n%s" % (target_name, to_unicode_text(save_err), detailed_error)
            write_utf8_line(error_message)
            write_utf8_line("SCRIPT_ERROR: %s" % error_message)
            sys.exit(1)
    else:
        write_utf8_line("DEBUG: No code parts were updated, skipping project save.")
    # --- END SAVING ---

    write_utf8_line("Code Set For: %s" % target_name)
    write_utf8_line("Path: %s" % to_unicode_text(POU_FULL_PATH))
    write_utf8_line("SCRIPT_SUCCESS: Declaration and/or implementation set successfully.")
    sys.exit(0)

except Exception as e:
    detailed_error = to_unicode_text(traceback.format_exc())
    error_message = "Error setting code for object '%s' in project '%s': %s\n%s" % (
        to_unicode_text(POU_FULL_PATH), to_unicode_text(PROJECT_FILE_PATH), to_unicode_text(e), detailed_error)
    write_utf8_line(error_message)
    write_utf8_line("SCRIPT_ERROR: %s" % error_message)
    sys.exit(1)
