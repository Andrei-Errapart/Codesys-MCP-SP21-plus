import React from 'react';
import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import { Viewer } from '../../src/tui/browser/Viewer.tsx';
import { POU } from '../../src/tui/shared/types.ts';

const pou: POU = {
  name: 'PLC_PRG',
  kind: 'PRG',
  relPath: 'PLC_PRG.st',
  absPath: '/abs/PLC_PRG.st',
  loc: 4,
  mtimeMs: 0,
};

const text = [
  'PROGRAM PLC_PRG',
  'VAR',
  '  counter : INT := 0;',
  '  bRunning : BOOL;',
  'END_VAR',
].join('\n');

describe('<Viewer>', () => {
  it('renders without overlay when liveValues is absent', () => {
    const { lastFrame } = render(
      <Viewer pou={pou} text={text} scrollTop={0} visibleRows={10} />
    );
    expect(lastFrame()).not.toContain('live:');
  });

  it('overlays "◀ live: <val>" on the line whose token matches a key', () => {
    const { lastFrame } = render(
      <Viewer
        pou={pou}
        text={text}
        scrollTop={0}
        visibleRows={10}
        liveValues={{
          counter: { value: '47', type: 'INT', ts: Date.now() },
          bRunning: { value: 'TRUE', type: 'BOOL', ts: Date.now() },
        }}
      />
    );
    const out = lastFrame()!;
    expect(out).toMatch(/counter\b.*◀ live: 47/);
    expect(out).toMatch(/bRunning\b.*◀ live: TRUE/);
  });

  it('does not overlay vars that are not in liveValues', () => {
    const { lastFrame } = render(
      <Viewer
        pou={pou}
        text={text}
        scrollTop={0}
        visibleRows={10}
        liveValues={{ counter: { value: '47', ts: Date.now() } }}
      />
    );
    const out = lastFrame()!;
    expect(out).toMatch(/counter\b.*◀ live: 47/);
    // bRunning line must not gain an overlay
    const bRunningLine = out.split('\n').find((l) => l.includes('bRunning'))!;
    expect(bRunningLine).not.toContain('live:');
  });
});
