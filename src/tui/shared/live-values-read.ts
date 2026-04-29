import * as fs from 'fs/promises';
import { LiveValuesPayload } from './live-values.js';

/**
 * Live values stop being interesting fast — tighter than the selection
 * file's 60s window. If the pump dies or the runtime goes offline, we'd
 * rather show no overlay than a frozen value.
 */
export const FRESHNESS_MS = 5_000;

export type ReadResult =
  | { status: 'ok'; payload: LiveValuesPayload }
  | { status: 'missing' }
  | { status: 'stale' }
  | { status: 'invalid'; reason: string };

export async function readLiveValues(filePath: string): Promise<ReadResult> {
  let text: string;
  try {
    text = await fs.readFile(filePath, 'utf8');
  } catch {
    return { status: 'missing' };
  }
  let parsed: LiveValuesPayload;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return { status: 'invalid', reason: (err as Error).message };
  }
  if (parsed.version !== 1) {
    return { status: 'invalid', reason: `unsupported version ${parsed.version}` };
  }
  const ageMs = Date.now() - new Date(parsed.updated_at).getTime();
  if (Number.isNaN(ageMs) || ageMs > FRESHNESS_MS) {
    return { status: 'stale' };
  }
  return { status: 'ok', payload: parsed };
}
