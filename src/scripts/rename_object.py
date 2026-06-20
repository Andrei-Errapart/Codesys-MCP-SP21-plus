import sys, scriptengine as script_engine, os, traceback, re

OBJECT_PATH = "{OBJECT_PATH}"
NEW_NAME = "{NEW_NAME}"
UPDATE_REFERENCES = "{UPDATE_REFERENCES}" == "1"

# Per OPEN-BUGS-CROSS-REFERENCE Bug 5: CODESYS scripting's rename()/set_name()
# is a node-local rename only. We optionally brute-force references by scanning
# every text-bearing POU/DUT/GVL and replacing identifier occurrences.


def _walk_pou_like(node, out):
    """Walk descendants and append objects exposing textual code."""
    has_text = False
    try:
        if hasattr(node, 'textual_declaration') or hasattr(node, 'textual_implementation'):
            has_text = True
    except Exception:
        pass
    if has_text:
        out.append(node)
    try:
        for child in node.get_children(False):
            _walk_pou_like(child, out)
    except Exception:
        pass


def _read_text(text_obj):
    """Return unicode .text from a textual_declaration / textual_implementation object."""
    if text_obj is None:
        return u''
    try:
        t = text_obj.text
    except Exception:
        return u''
    return to_unicode_text(t) if t else u''


def _safe_set_text(target_node, attr_name, new_text):
    try:
        text_obj = getattr(target_node, attr_name, None)
    except Exception as e:
        return False, "getattr %s: %s" % (attr_name, to_unicode_text(e))
    if text_obj is None:
        return False, "%s is None" % attr_name
    if not hasattr(text_obj, 'replace'):
        return False, "%s has no replace()" % attr_name
    try:
        text_obj.replace(to_unicode_text(new_text))
        return True, None
    except Exception as e:
        return False, "%s.replace failed: %s" % (attr_name, to_unicode_text(e))


try:
    print("DEBUG: rename_object script: ObjectPath='%s', NewName='%s', UpdateReferences=%s, Project='%s'" % (
        to_unicode_text(OBJECT_PATH), to_unicode_text(NEW_NAME), UPDATE_REFERENCES, to_unicode_text(PROJECT_FILE_PATH)))
    primary_project = ensure_project_open(PROJECT_FILE_PATH)
    if not OBJECT_PATH:
        raise ValueError("Object path empty.")
    if not NEW_NAME:
        raise ValueError("New name empty.")

    target_object = find_object_by_path_robust(primary_project, OBJECT_PATH, "target object")
    if not target_object:
        raise ValueError("Object not found at path: %s" % to_unicode_text(OBJECT_PATH))

    old_name = to_unicode_text(getattr(target_object, 'get_name', lambda: OBJECT_PATH)())
    target_type = to_unicode_text(type(target_object).__name__)
    print("DEBUG: Found target object: %s (Type: %s)" % (old_name, target_type))

    old_identifier = old_name
    target_object_id = None
    try:
        if hasattr(target_object, 'get_id'):
            target_object_id = target_object.get_id()
    except Exception:
        pass

    if hasattr(target_object, 'set_name'):
        print("DEBUG: Calling set_name('%s') on object '%s'" % (to_unicode_text(NEW_NAME), old_name))
        target_object.set_name(NEW_NAME)
        print("DEBUG: Object renamed.")
    elif hasattr(target_object, 'rename'):
        print("DEBUG: Calling rename('%s') on object '%s'" % (to_unicode_text(NEW_NAME), old_name))
        target_object.rename(NEW_NAME)
        print("DEBUG: Object renamed.")
    else:
        raise TypeError("Object '%s' of type %s does not support set_name() or rename()." % (old_name, target_type))

    refs_updated = []
    refs_skipped_errors = []
    if UPDATE_REFERENCES and old_identifier and old_identifier != NEW_NAME:
        print("DEBUG: Updating references: \\b%s\\b -> %s" % (old_identifier, to_unicode_text(NEW_NAME)))
        pattern = re.compile(r'\b' + re.escape(old_identifier) + r'\b')

        def _replace_fn(m):
            return to_unicode_text(NEW_NAME)

        all_text_nodes = []
        try:
            for child in primary_project.get_children(False):
                _walk_pou_like(child, all_text_nodes)
        except Exception as walk_err:
            print("WARN: walking project tree for references failed: %s" % to_unicode_text(walk_err))

        print("DEBUG: %d text-bearing node(s) to scan for references." % len(all_text_nodes))

        for node in all_text_nodes:
            try:
                node_id = node.get_id() if hasattr(node, 'get_id') else None
            except Exception:
                node_id = None
            if target_object_id is not None and node_id is not None and node_id == target_object_id:
                continue

            try:
                node_name = to_unicode_text(node.get_name() if hasattr(node, 'get_name') else '?')
            except Exception:
                node_name = u'?'

            decl_obj = getattr(node, 'textual_declaration', None) if hasattr(node, 'textual_declaration') else None
            impl_obj = getattr(node, 'textual_implementation', None) if hasattr(node, 'textual_implementation') else None
            old_decl = _read_text(decl_obj)
            old_impl = _read_text(impl_obj)

            new_decl = pattern.sub(_replace_fn, old_decl) if old_decl else old_decl
            new_impl = pattern.sub(_replace_fn, old_impl) if old_impl else old_impl

            decl_changed = (new_decl != old_decl)
            impl_changed = (new_impl != old_impl)
            if not (decl_changed or impl_changed):
                continue

            print("DEBUG: rewriting refs in '%s' (decl_changed=%s, impl_changed=%s)" % (
                node_name, decl_changed, impl_changed))

            if decl_changed:
                ok, err = _safe_set_text(node, 'textual_declaration', new_decl)
                if not ok:
                    refs_skipped_errors.append("%s decl: %s" % (node_name, err))
                    continue
            if impl_changed:
                ok, err = _safe_set_text(node, 'textual_implementation', new_impl)
                if not ok:
                    refs_skipped_errors.append("%s impl: %s" % (node_name, err))
                    continue
            refs_updated.append(node_name)

        print("DEBUG: Updated references in %d node(s); skipped %d on errors." % (
            len(refs_updated), len(refs_skipped_errors)))
        for err in refs_skipped_errors:
            print("WARN: ref-update skipped: %s" % to_unicode_text(err))
    elif not UPDATE_REFERENCES:
        print("DEBUG: UPDATE_REFERENCES=0 -- skipping reference rewrite (caller opted out).")
    else:
        print("DEBUG: old==new -- skipping reference rewrite.")

    try:
        print("DEBUG: Saving Project...")
        primary_project.save()
        print("DEBUG: Project saved successfully after rename.")
    except Exception as save_err:
        print("ERROR: Failed to save Project after renaming object: %s" % to_unicode_text(save_err))
        detailed_error = to_unicode_text(traceback.format_exc())
        error_message = "Error saving Project after renaming '%s' to '%s': %s\n%s" % (
            old_name, to_unicode_text(NEW_NAME), to_unicode_text(save_err), detailed_error)
        print(error_message)
        print("SCRIPT_ERROR: %s" % error_message)
        sys.exit(1)

    print("Object Renamed: '%s' -> '%s'" % (old_name, to_unicode_text(NEW_NAME)))
    print("Object Type: %s" % target_type)
    print("Path: %s" % to_unicode_text(OBJECT_PATH))
    if UPDATE_REFERENCES:
        print("References Updated In: %d node(s)" % len(refs_updated))
        if refs_updated:
            print("Updated Nodes: %s" % ", ".join(to_unicode_text(n) for n in refs_updated))
    print("SCRIPT_SUCCESS: Object renamed successfully.")
    sys.exit(0)
except Exception as e:
    detailed_error = to_unicode_text(traceback.format_exc())
    error_message = "Error renaming object '%s' in project '%s': %s\n%s" % (
        to_unicode_text(OBJECT_PATH), to_unicode_text(PROJECT_FILE_PATH), to_unicode_text(e), detailed_error)
    print(error_message)
    print("SCRIPT_ERROR: %s" % error_message)
    sys.exit(1)
