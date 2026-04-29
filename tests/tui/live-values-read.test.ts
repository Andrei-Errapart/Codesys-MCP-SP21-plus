import { describe, it, expect } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { readLiveValues, FRESHNESS_MS } from '../../src/tui/shared/live-values-read.ts';

async function tmpFile(content: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'phobics-lv-'));
  const f = path.join(dir, 'tui-live-values.json');
  await fs.writeFile(f, content, 'utf8');
  return f;
}

const fresh = (overrides: Record<string, unknown> = {}) =>
  JSON.stringify({
    version: 1,
    updated_at: new Date().toISOString(),
    project_dir: '/p',
    device: 'D1',
    pou_name: 'PLC_PRG',
    values: {
      counter: { value: '47', type: 'INT', ts: Date.now() },
    },
    ...overrides,
  });

describe('readLiveValues', () => {
  it('returns ok with the parsed payload when fresh', async () => {
    const f = await tmpFile(fresh());
    const r = await readLiveValues(f);
    expect(r.status).toBe('ok');
    if (r.status === 'ok') {
      expect(r.payload.pou_name).toBe('PLC_PRG');
      expect(r.payload.values['counter'].value).toBe('47');
    }
  });

  it('returns stale when older than FRESHNESS_MS', async () => {
    const old = JSON.stringify({
      ...JSON.parse(fresh()),
      updated_at: new Date(Date.now() - FRESHNESS_MS - 1000).toISOString(),
    });
    const f = await tmpFile(old);
    expect((await readLiveValues(f)).status).toBe('stale');
  });

  it('returns missing when file does not exist', async () => {
    expect((await readLiveValues('/nonexistent.json')).status).toBe('missing');
  });

  it('returns invalid for malformed JSON', async () => {
    const f = await tmpFile('not json');
    expect((await readLiveValues(f)).status).toBe('invalid');
  });
});
