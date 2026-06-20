import sys, scriptengine as script_engine, os, traceback, codecs

# Mirrors the CODESYS project tree into a filesystem layout under MIRROR_ROOT
# so the project becomes browseable / diffable / AI-editable as plain text.
#
#  - Structural nodes (Device, Application, Folder, ...) become directories.
#  - Code-bearing nodes (Program, FB, Function, Method, Property, DUT, GVL,
#    Interface, ...) become .st files in their parent directory.
#  - If a code-bearing node has child code objects (e.g. an FB with methods)
#    those children land in a sibling subdirectory with the parent's name.
#  - Filesystem-illegal characters in CODESYS object names are replaced with
#    '_'; the original CODESYS project path is recorded as a header comment
#    in each file so a future write-back tool can map it back to set_pou_code's
#    pouPath.
#
# Phase 1: read-only export. No write-back here.

MIRROR_ROOT = r"{MIRROR_ROOT}"
ILLEGAL = '<>:"|?*'


def resolve_mirror_root(project_file_path):
    """Default mirror dir when the TS caller passes MIRROR_ROOT=''."""
    project_dir = os.path.dirname(project_file_path)
    legacy = os.path.join(project_dir, 'mcp-mirror')
    try:
        if os.path.isdir(legacy):
            return legacy
    except Exception:
        pass
    siblings = 0
    try:
        for entry in os.listdir(project_dir):
            if entry.lower().endswith('.project'):
                siblings += 1
    except Exception:
        return legacy
    if siblings <= 1:
        return legacy
    base = os.path.basename(project_file_path)
    if base.lower().endswith('.project'):
        base = base[:-len('.project')]
    return os.path.join(project_dir, base + '_mcp_mirror')


def sanitise(name):
    s = to_unicode_text(name or u'').replace('/', '_').replace('\\', '_')
    for c in ILLEGAL:
        s = s.replace(c, '_')
    s = s.strip().rstrip('.')
    return s if s else '_unnamed_'


def _strip_leading_noise(decl):
    """Drop leading whitespace, // and (* *) comments, and {attribute := ''}
    pragmas so the kind classifier matches the actual IEC keyword."""
    s = to_unicode_text(decl)
    changed = True
    while changed:
        changed = False
        s2 = s.lstrip()
        if s2 != s:
            s = s2
            changed = True
        if s.startswith('//'):
            nl = s.find('\n')
            s = s[nl + 1:] if nl >= 0 else ''
            changed = True
            continue
        if s.startswith('(*'):
            end = s.find('*)')
            s = s[end + 2:] if end >= 0 else ''
            changed = True
            continue
        if s.startswith('{'):
            end = s.find('}')
            s = s[end + 1:] if end >= 0 else ''
            changed = True
            continue
    return s


def classify(decl):
    if not decl:
        return 'UNKNOWN'
    head = _strip_leading_noise(decl).upper()
    if head.startswith('TYPE'):
        return 'DUT'
    if head.startswith('VAR_GLOBAL'):
        return 'GVL'
    if head.startswith('PROGRAM'):
        return 'PROGRAM'
    if head.startswith('FUNCTION_BLOCK'):
        return 'FB'
    if head.startswith('FUNCTION'):
        return 'FUNCTION'
    if head.startswith('METHOD'):
        return 'METHOD'
    if head.startswith('PROPERTY'):
        return 'PROPERTY'
    if head.startswith('INTERFACE'):
        return 'INTERFACE'
    return 'OTHER'


def get_text(obj, attr):
    if not hasattr(obj, attr):
        return u''
    try:
        x = getattr(obj, attr)
        if x and hasattr(x, 'text'):
            return to_unicode_text(x.text)
    except Exception:
        pass
    return u''


def write_one(parent_dir, name, decl, impl, project_path):
    name = to_unicode_text(name)
    decl = to_unicode_text(decl)
    impl = to_unicode_text(impl)
    project_path = to_unicode_text(project_path)
    if not os.path.exists(parent_dir):
        os.makedirs(parent_dir)
    kind = classify(decl)
    fname = sanitise(name) + '.st'
    fpath = os.path.join(parent_dir, fname)

    lines = []
    lines.append(u'(* === CODESYS export -- %s === *)' % kind)
    lines.append(u'(* Project path: %s *)' % project_path)
    # Deliberately no generated timestamp: stable output for release diffing.
    lines.append(u'')
    if decl:
        lines.append(decl.rstrip())
        lines.append(u'')
    if impl:
        if decl:
            lines.append(u'(* ============ IMPLEMENTATION ============ *)')
            lines.append(u'')
        lines.append(impl.rstrip())
        lines.append(u'')

    # UTF-8 because CODESYS POU text may contain Chinese, smart quotes, degree
    # signs, etc. The text has already been normalised losslessly above.
    f = codecs.open(fpath, 'w', encoding='utf-8')
    try:
        f.write(u'\n'.join(to_unicode_text(l) for l in lines))
    finally:
        f.close()
    return fpath, kind, os.path.getsize(fpath)


def walk(node, parent_fs_dir, parent_proj_path, stats):
    try:
        gn = getattr(node, 'get_name', None)
        name = to_unicode_text(gn() if gn else '?')
    except Exception:
        name = u'?'
    safe_name = sanitise(name)
    proj_path = (to_unicode_text(parent_proj_path) + u'/' + name) if parent_proj_path else name

    decl = get_text(node, 'textual_declaration')
    impl = get_text(node, 'textual_implementation')

    if decl or impl:
        try:
            fpath, kind, size = write_one(parent_fs_dir, name, decl, impl, proj_path)
            stats['files'].append({'path': fpath, 'project_path': proj_path, 'kind': kind, 'bytes': size})
        except Exception as e:
            stats['errors'].append({'project_path': proj_path, 'error': to_unicode_text(e)})

    new_dir = os.path.join(parent_fs_dir, safe_name)
    try:
        children = list(node.get_children(False))
    except Exception:
        children = []
    if children:
        if not os.path.exists(new_dir):
            try:
                os.makedirs(new_dir)
                stats['dirs_created'] += 1
            except Exception as e:
                stats['errors'].append({'project_path': proj_path, 'error': 'mkdir: %s' % to_unicode_text(e)})
                return
        for c in children:
            walk(c, new_dir, proj_path, stats)


try:
    if not MIRROR_ROOT.strip():
        MIRROR_ROOT = resolve_mirror_root(PROJECT_FILE_PATH)
    print("DEBUG: mirror_export: Project='%s' MirrorRoot='%s'" % (to_unicode_text(PROJECT_FILE_PATH), to_unicode_text(MIRROR_ROOT)))
    primary_project = ensure_project_open(PROJECT_FILE_PATH)

    if not os.path.exists(MIRROR_ROOT):
        os.makedirs(MIRROR_ROOT)

    stats = {'files': [], 'dirs_created': 0, 'errors': []}

    for child in primary_project.get_children(False):
        walk(child, MIRROR_ROOT, u'', stats)

    by_kind = {}
    total_bytes = 0
    for entry in stats['files']:
        by_kind[entry['kind']] = by_kind.get(entry['kind'], 0) + 1
        total_bytes += entry['bytes']

    print("--- Mirror summary ---")
    print("Files written:    %d" % len(stats['files']))
    print("Directories made: %d" % stats['dirs_created'])
    print("Total bytes:      %d" % total_bytes)
    print("By kind:")
    for k in sorted(by_kind.keys()):
        print("  %-10s %d" % (k, by_kind[k]))
    if stats['errors']:
        print("Errors: %d" % len(stats['errors']))
        for er in stats['errors'][:10]:
            print("  %s -> %s" % (to_unicode_text(er.get('project_path', '?')), to_unicode_text(er.get('error', '?'))))
    print("SCRIPT_SUCCESS: mirror exported to %s" % to_unicode_text(MIRROR_ROOT))
    sys.exit(0)
except Exception as e:
    msg = "Error in mirror_export for project '%s': %s\n%s" % (
        to_unicode_text(PROJECT_FILE_PATH), to_unicode_text(e), to_unicode_text(traceback.format_exc()))
    print(msg)
    print("SCRIPT_ERROR: %s" % msg)
    sys.exit(1)
