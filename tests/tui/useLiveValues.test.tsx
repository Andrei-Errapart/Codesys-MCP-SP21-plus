import React from 'react';
import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import { Text } from 'ink';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { useLiveValues } from '../../src/tui/browser/useLiveValues.tsx';

async function tmpFile(content: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'phobics-uv-'));
  const f = path.join(dir, 'tui-live-values.json');
  await fs.writeFile(f, content, 'utf8');
  return f;
}

const fresh = (pouName = 'PLC_PRG') =>
  JSON.stringify({
    version: 1,
    updated_at: new Date().toISOString(),
    project_dir: '/p',
    device: 'D1',
    pou_name: pouName,
    values: { counter: { value: '47', ts: Date.now() } },
  });

function Probe({ filePath, pouName }: { filePath: string; pouName: string | null }) {
  const lv = useLiveValues(filePath, pouName, 50);
  return <Text>{lv ? `MATCH:${Object.keys(lv).join(',')}` : 'NULL'}</Text>;
}

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe('useLiveValues', () => {
  it('returns map when pou_name matches', async () => {
    const f = await tmpFile(fresh('PLC_PRG'));
    const { lastFrame, unmount } = render(<Probe filePath={f} pouName="PLC_PRG" />);
    await wait(120);
    expect(lastFrame()).toBe('MATCH:counter');
    unmount();
  });

  it('returns null when pou_name does not match', async () => {
    const f = await tmpFile(fresh('FB_Other'));
    const { lastFrame, unmount } = render(<Probe filePath={f} pouName="PLC_PRG" />);
    await wait(120);
    expect(lastFrame()).toBe('NULL');
    unmount();
  });

  it('returns null when pouName is null (cursor not on a POU)', async () => {
    const f = await tmpFile(fresh('PLC_PRG'));
    const { lastFrame, unmount } = render(<Probe filePath={f} pouName={null} />);
    await wait(120);
    expect(lastFrame()).toBe('NULL');
    unmount();
  });
});
