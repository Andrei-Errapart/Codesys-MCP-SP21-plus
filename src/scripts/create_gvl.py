# -*- coding: utf-8 -*-
import sys, scriptengine as script_engine, os, traceback
import base64
import binascii

GVL_NAME = "{GVL_NAME}"
PARENT_PATH_REL = "{PARENT_PATH}"
# Legacy transport: TS currently injects this as a Python unicode literal.
# Keep it as fallback until every caller passes DECLARATION_CONTENT_B64.
DECLARATION_CONTENT_LEGACY = u"""{DECLARATION_CONTENT}"""
# New transport: base64(utf-8) keeps arbitrary IEC text out of the Python
# source template, matching set_pou_code's Unicode-safe path.
DECLARATION_CONTENT_B64 = "{DECLARATION_CONTENT_B64}"

try:
    def log_line(value=u""):
        write_utf8_line(to_unicode_text(value))

    def decode_b64_utf8(label, payload):
        if not payload or payload.startswith("{"):
            return None
        try:
            raw = base64.b64decode(payload)
        except (TypeError, binascii.Error) as decode_err:
            raise ValueError(
                "Expected valid base64 string for %s. Base64 decode failed: %s"
                % (label, to_unicode_text(decode_err))
            )
        try:
            return raw.decode("utf-8")
        except UnicodeDecodeError as decode_err:
            raise ValueError(
                "Expected UTF-8 text for %s. UTF-8 decode failed: %s"
                % (label, to_unicode_text(decode_err))
            )

    decoded_decl = decode_b64_utf8("declaration", DECLARATION_CONTENT_B64)
    if decoded_decl is None:
        DECLARATION_CONTENT = to_unicode_text(DECLARATION_CONTENT_LEGACY)
    else:
        DECLARATION_CONTENT = decoded_decl

    log_line("DEBUG: create_gvl script: Name='%s', ParentPath='%s', Project='%s'" % (to_unicode_text(GVL_NAME), to_unicode_text(PARENT_PATH_REL), to_unicode_text(PROJECT_FILE_PATH)))
    primary_project = ensure_project_open(PROJECT_FILE_PATH)
    if not GVL_NAME: raise ValueError("GVL name empty.")
    if not PARENT_PATH_REL: raise ValueError("Parent path empty.")

    # Find parent object (same logic as create_pou)
    if PARENT_PATH_REL == "Application":
        project_name = os.path.splitext(os.path.basename(PROJECT_FILE_PATH))[0]
        potential_paths = [
            PARENT_PATH_REL,
            "%s.%s" % (project_name, PARENT_PATH_REL),
            "%s/%s" % (project_name, PARENT_PATH_REL),
        ]
        parent_object = None
        for path in potential_paths:
            parent_candidate = find_object_by_path_robust(primary_project, path, "parent container")
            if parent_candidate:
                parent_object = parent_candidate
                log_line("DEBUG: Found parent using path: '%s'" % to_unicode_text(path))
                break
        if not parent_object:
            try:
                if hasattr(primary_project, 'active_application'):
                    app = primary_project.active_application
                    if app:
                        parent_object = app
                        log_line("DEBUG: Found application directly: %s" % to_unicode_text(app.get_name()))
                if not parent_object and hasattr(primary_project, 'find'):
                    apps = primary_project.find("Application", True)
                    if apps:
                        parent_object = apps[0]
            except Exception as e:
                log_line("ERROR: Direct application access failed: %s" % to_unicode_text(e))
    else:
        parent_object = find_object_by_path_robust(primary_project, PARENT_PATH_REL, "parent container")

    if not parent_object:
        raise ValueError("Parent object not found for path: %s" % to_unicode_text(PARENT_PATH_REL))

    parent_name = to_unicode_text(getattr(parent_object, 'get_name', lambda: str(parent_object))())
    log_line("DEBUG: Using parent object: %s" % parent_name)

    # Create the GVL
    if not hasattr(parent_object, 'create_gvl'):
        raise TypeError("Parent object '%s' of type %s does not support create_gvl." % (parent_name, to_unicode_text(type(parent_object).__name__)))

    log_line("DEBUG: Calling create_gvl: Name='%s'" % to_unicode_text(GVL_NAME))
    new_gvl = parent_object.create_gvl(name=GVL_NAME)

    if new_gvl:
        new_gvl_name = to_unicode_text(getattr(new_gvl, 'get_name', lambda: GVL_NAME)())
        log_line("DEBUG: GVL object created: %s" % new_gvl_name)

        # Optionally set declaration code
        if DECLARATION_CONTENT.strip():
            log_line("DEBUG: Setting GVL declaration code...")
            if hasattr(new_gvl, 'textual_declaration'):
                try:
                    new_gvl.textual_declaration.replace(DECLARATION_CONTENT)
                    log_line("DEBUG: GVL declaration code set successfully.")
                except Exception as decl_err:
                    log_line("WARN: Failed to set GVL declaration via textual_declaration.replace: %s" % to_unicode_text(decl_err))
                    # Try alternative
                    if hasattr(new_gvl.textual_declaration, 'text'):
                        try:
                            new_gvl.textual_declaration.text = DECLARATION_CONTENT
                            log_line("DEBUG: GVL declaration code set via .text property.")
                        except Exception as text_err:
                            log_line("WARN: Failed to set GVL declaration via .text: %s" % to_unicode_text(text_err))
            else:
                log_line("WARN: GVL object does not have textual_declaration attribute.")

        try:
            log_line("DEBUG: Saving Project...")
            primary_project.save()
            log_line("DEBUG: Project saved successfully after GVL creation.")
        except Exception as save_err:
            log_line("ERROR: Failed to save Project after GVL creation: %s" % to_unicode_text(save_err))
            detailed_error = to_unicode_text(traceback.format_exc())
            error_message = "Error saving Project after creating GVL '%s': %s\n%s" % (new_gvl_name, to_unicode_text(save_err), detailed_error)
            log_line(error_message); log_line("SCRIPT_ERROR: %s" % error_message); sys.exit(1)

        log_line("GVL Created: %s" % new_gvl_name)
        log_line("Parent Path: %s" % to_unicode_text(PARENT_PATH_REL))
        log_line("SCRIPT_SUCCESS: GVL created successfully.")
        sys.stdout.flush()
        sys.exit(0)
    else:
        error_message = "Failed to create GVL '%s'. create_gvl returned None." % to_unicode_text(GVL_NAME)
        log_line(error_message); log_line("SCRIPT_ERROR: %s" % error_message); sys.exit(1)
except Exception as e:
    detailed_error = to_unicode_text(traceback.format_exc())
    error_message = "Error creating GVL '%s' in project '%s': %s\n%s" % (to_unicode_text(GVL_NAME), to_unicode_text(PROJECT_FILE_PATH), to_unicode_text(e), detailed_error)
    write_utf8_line(error_message); write_utf8_line("SCRIPT_ERROR: %s" % error_message)
    sys.stdout.flush()
    sys.exit(1)
