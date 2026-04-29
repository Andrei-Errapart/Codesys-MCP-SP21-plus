import { describe, it, expect } from 'vitest';
import { parseVarNames } from '../../src/live-values-pump';

describe('parseVarNames', () => {
  it('extracts vars from a single VAR block', () => {
    const text = [
      'PROGRAM PLC_PRG',
      'VAR',
      '  counter : INT := 0;',
      '  bRunning : BOOL;',
      '  rTemperature : REAL;',
      'END_VAR',
    ].join('\n');
    expect(parseVarNames(text)).toEqual(['counter', 'bRunning', 'rTemperature']);
  });

  it('handles VAR_INPUT / VAR_OUTPUT / VAR_GLOBAL too', () => {
    const text = [
      'FUNCTION_BLOCK FB_X',
      'VAR_INPUT',
      '  x : INT;',
      'END_VAR',
      'VAR_OUTPUT',
      '  y : BOOL;',
      'END_VAR',
      'VAR',
      '  internal : DINT;',
      'END_VAR',
    ].join('\n');
    expect(parseVarNames(text).sort()).toEqual(['internal', 'x', 'y']);
  });

  it('ignores lines inside (* ... *) blocks and after //', () => {
    const text = [
      'VAR',
      '  alpha : INT;',
      '  (* commentedOut : BOOL; *)',
      '  beta : INT; // tail comment',
      'END_VAR',
    ].join('\n');
    expect(parseVarNames(text)).toEqual(['alpha', 'beta']);
  });

  it('returns [] when no VAR block is present', () => {
    expect(parseVarNames('PROGRAM X\nEND_PROGRAM')).toEqual([]);
  });

  it('handles AT %X10.0 location prefix and := initializer', () => {
    const text = [
      'VAR',
      '  bRelay AT %QX0.1 : BOOL := FALSE;',
      '  iCount : INT := 42;',
      'END_VAR',
    ].join('\n');
    expect(parseVarNames(text)).toEqual(['bRelay', 'iCount']);
  });
});
