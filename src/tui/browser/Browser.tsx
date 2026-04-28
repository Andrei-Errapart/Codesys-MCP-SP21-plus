import React from 'react';
import { Box, Text, useInput, useStdout } from 'ink';
import { Project, POU, Selection } from '../shared/types.js';
import { Tree, devicePath, pouPath } from './Tree.js';
import { Viewer } from './Viewer.js';
import { formatStaleness, ResizeWarning } from './Statusbar.js';

export interface BrowserProps {
  project: Project;
  readPou: (pou: POU) => Promise<string>;
  writeSelection: (s: Selection) => void;
  onQuit: () => void;
  onRescan?: () => void;
  onOpenInEditor?: (absPath: string) => void;
}

interface FlatRow {
  path: string;
  kind: 'device' | 'pou';
  device: string;
  pou?: POU;
}

function flatten(project: Project, expanded: Set<string>, filter: string): FlatRow[] {
  const f = filter.toLowerCase();
  const rows: FlatRow[] = [];
  for (const dev of project.devices) {
    const matchingPous = f
      ? dev.pous.filter((p) => p.name.toLowerCase().includes(f))
      : dev.pous;
    if (f && matchingPous.length === 0) continue;
    rows.push({ path: devicePath(dev.name), kind: 'device', device: dev.name });
    const isExpanded = f ? true : expanded.has(devicePath(dev.name));
    if (!isExpanded) continue;
    for (const p of matchingPous) {
      rows.push({ path: pouPath(dev.name, p.relPath), kind: 'pou', device: dev.name, pou: p });
    }
  }
  return rows;
}

export function Browser({ project, readPou, writeSelection, onQuit, onRescan, onOpenInEditor }: BrowserProps): React.ReactElement {
  const [expanded, setExpanded] = React.useState<Set<string>>(new Set());
  const [cursorIdx, setCursorIdx] = React.useState(0);
  const [text, setText] = React.useState<string | null>(null);
  const [scrollTop] = React.useState(0);
  const [helpOpen, setHelpOpen] = React.useState(false);
  const [filterMode, setFilterMode] = React.useState(false);
  const [filter, setFilter] = React.useState('');

  const filteredProject = React.useMemo(() => {
    if (!filter) return project;
    const f = filter.toLowerCase();
    return {
      ...project,
      devices: project.devices
        .map((d) => ({ ...d, pous: d.pous.filter((p) => p.name.toLowerCase().includes(f)) }))
        .filter((d) => d.pous.length > 0),
    };
  }, [project, filter]);

  const effectiveExpanded = React.useMemo(() => {
    if (!filter) return expanded;
    const next = new Set(expanded);
    for (const d of filteredProject.devices) next.add(devicePath(d.name));
    return next;
  }, [expanded, filter, filteredProject]);

  const rows = React.useMemo(
    () => flatten(filteredProject, effectiveExpanded, ''),
    [filteredProject, effectiveExpanded]
  );
  const cursor = rows[Math.min(cursorIdx, rows.length - 1)];

  React.useEffect(() => {
    if (!cursor || cursor.kind !== 'pou' || !cursor.pou) return;
    const handle = setTimeout(() => {
      writeSelection({ device: cursor.device, pou: cursor.pou!, viewerLine: scrollTop + 1 });
    }, 200);
    return () => clearTimeout(handle);
  }, [cursor, scrollTop, writeSelection]);

  React.useEffect(() => {
    if (!cursor || cursor.kind !== 'pou' || !cursor.pou) {
      setText(null);
      return;
    }
    let cancelled = false;
    readPou(cursor.pou).then((t) => {
      if (!cancelled) setText(t);
    });
    return () => {
      cancelled = true;
    };
  }, [cursor, readPou]);

  useInput((input, key) => {
    if (filterMode) {
      if (key.escape) {
        setFilter('');
        setFilterMode(false);
        return;
      }
      if (key.return) {
        setFilterMode(false);
        return;
      }
      if (key.backspace || key.delete) {
        setFilter((s) => s.slice(0, -1));
        return;
      }
      if (input && !key.ctrl && !key.meta) {
        setFilter((s) => s + input);
        return;
      }
      return;
    }
    if (input === '?') {
      setHelpOpen((v) => !v);
      return;
    }
    if (helpOpen) {
      if (key.escape) setHelpOpen(false);
      return;
    }
    if (input === '/') {
      setFilterMode(true);
      setCursorIdx(0);
      return;
    }
    if (key.escape && filter) {
      setFilter('');
      return;
    }
    if (input === 'q') return onQuit();
    if (input === 'r' && onRescan) return onRescan();
    if (input === 'o' && onOpenInEditor && cursor?.kind === 'pou' && cursor.pou) {
      return onOpenInEditor(cursor.pou.absPath);
    }
    if (input === 'j' || key.downArrow) {
      setCursorIdx((i) => Math.min(i + 1, rows.length - 1));
    } else if (input === 'k' || key.upArrow) {
      setCursorIdx((i) => Math.max(i - 1, 0));
    } else if (input === 'l' || key.return || key.rightArrow) {
      if (cursor && cursor.kind === 'device') {
        setExpanded((e) => {
          const next = new Set(e);
          next.add(cursor.path);
          return next;
        });
      }
    } else if (input === 'h' || key.leftArrow) {
      if (cursor && cursor.kind === 'device') {
        setExpanded((e) => {
          const next = new Set(e);
          next.delete(cursor.path);
          return next;
        });
      }
    }
  });

  const { stdout } = useStdout();
  const columns = stdout?.columns ?? 80;
  const termRows = stdout?.rows ?? 24;
  const stale = formatStaleness(project.mirrorMtimeMs);

  return (
    <Box flexDirection="column">
      <Text>
        ─ {project.rootDir.split(/[/\\]/).pop()} ─{stale ? ` mirror ${stale} old ` : ' '}─
      </Text>
      <ResizeWarning columns={columns} rows={termRows} />
      {helpOpen && <HelpOverlay />}
      {(filterMode || filter) && (
        <Text color={filterMode ? 'cyan' : undefined}>
          Filter: {filter}{filterMode ? '_' : ''}
        </Text>
      )}
      <Box flexDirection="row">
        <Box flexDirection="column" width="40%">
          <Tree project={filteredProject} cursorPath={cursor?.path ?? ''} expanded={effectiveExpanded} />
        </Box>
        <Box flexDirection="column" width="60%">
          <Viewer pou={cursor?.pou ?? null} text={text} scrollTop={scrollTop} visibleRows={20} />
        </Box>
      </Box>
      <Text>j/k nav  l expand  h collapse  / filter  o open  r rescan  ? help  q quit</Text>
    </Box>
  );
}

function HelpOverlay(): React.ReactElement {
  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1}>
      <Text bold>Keybindings</Text>
      <Text>  j / ↓     move cursor down</Text>
      <Text>  k / ↑     move cursor up</Text>
      <Text>  l / →     expand device</Text>
      <Text>  h / ←     collapse device</Text>
      <Text>  /         filter POU list (Enter commits, Esc clears)</Text>
      <Text>  o         open highlighted POU in $EDITOR (or VS Code)</Text>
      <Text>  r         re-scan mcp-mirror/</Text>
      <Text>  ?         toggle this help</Text>
      <Text>  Esc       close help</Text>
      <Text>  q         quit</Text>
    </Box>
  );
}
