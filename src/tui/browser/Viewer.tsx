import React from 'react';
import { Box, Text } from 'ink';
import { POU } from '../shared/types.js';
import { Token, tokenizeLines, TokenKind } from './highlight.js';
import { LiveValueSnapshot } from '../shared/live-values.js';

const COLORS: Record<TokenKind, string | undefined> = {
  keyword: 'cyan',
  type: 'magenta',
  comment: 'gray',
  string: 'yellow',
  text: undefined,
};

function HighlightedTokens({ tokens }: { tokens: Token[] }): React.ReactElement {
  return (
    <Text>
      {tokens.map((t, i) => (
        <Text key={i} color={COLORS[t.kind]}>
          {t.text}
        </Text>
      ))}
    </Text>
  );
}

/**
 * Find the first var name on the line that has a live value.
 *
 * Match rule: scan the raw line for identifiers, return the value of the
 * first one that's a key in liveValues. Operates on the original line text
 * (not on highlighter tokens) because the highlighter's uppercase-only
 * identifier splitter shreds mixed-case names like `bRunning` into
 * `b` + `R` + `unning`, which would never match a `bRunning` key.
 */
function findOverlayValue(
  line: string,
  liveValues: Record<string, LiveValueSnapshot>
): string | null {
  const re = /[A-Za-z_][A-Za-z0-9_]*/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line)) !== null) {
    const v = liveValues[m[0]];
    if (v) return v.value;
  }
  return null;
}

export interface ViewerProps {
  pou: POU | null;
  text: string | null;
  scrollTop: number;
  visibleRows: number;
  /** Optional bare-name → live-value map. When set, lines with a matching var get an inline overlay. */
  liveValues?: Record<string, LiveValueSnapshot>;
}

export function Viewer({ pou, text, scrollTop, visibleRows, liveValues }: ViewerProps): React.ReactElement {
  if (!pou || text == null) {
    return (
      <Box flexDirection="column">
        <Text dimColor>(no POU selected)</Text>
      </Box>
    );
  }
  const lines = text.split(/\r?\n/);
  // Tokenize from line 0 so multi-line (* ... *) state is correct, then
  // slice the visible window. Cheap; line count is bounded by file size.
  const allTokens = React.useMemo(() => tokenizeLines(lines), [text]);
  const sliceTokens = allTokens.slice(scrollTop, scrollTop + visibleRows);
  return (
    <Box flexDirection="column">
      <Text bold>
        {pou.name}.st  ({pou.kind}, {pou.loc} L)
      </Text>
      {sliceTokens.map((tokens, i) => {
        const lineNo = scrollTop + i;
        const overlay = liveValues ? findOverlayValue(lines[lineNo] ?? '', liveValues) : null;
        return (
          <Text key={lineNo}>
            <Text dimColor>{String(lineNo + 1).padStart(4, ' ')}  </Text>
            <HighlightedTokens tokens={tokens} />
            {overlay !== null && <Text color="green">  ◀ live: {overlay}</Text>}
          </Text>
        );
      })}
    </Box>
  );
}
