import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

describe('HeadlessExecutor', () => {
  it('writes temp scripts as utf-8 for Unicode payload safety', () => {
    const source = fs.readFileSync(
      path.join(__dirname, '..', '..', 'src', 'headless.ts'),
      'utf-8'
    );
    expect(source).toContain("fs.writeFileSync(tempFilePath, normalized, 'utf-8');");
  });
});
