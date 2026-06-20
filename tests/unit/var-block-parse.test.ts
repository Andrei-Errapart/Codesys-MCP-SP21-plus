import { describe, it, expect } from 'vitest';
import { parseVarNames, parseVarDecls } from '../../src/live-values-pump';

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

  it('ignores Chinese comments (// and (* *)) while still seeing ASCII decls', () => {
    // Regression: the VAR-block parser strips comments before applying the
    // ASCII identifier regex. Chinese inside // or (* *) must not be
    // mistaken for a variable name, an unterminated comment, or break the
    // state machine across multiple lines.
    const text = [
      '// 文件头注释',
      'VAR',
      '  // 温度上限注释',
      '  iCount : INT;',
      '  (* 中文块注释，可以多行',
      '     第二行也在块里 *)',
      '  bRun : BOOL; // 行尾中文注释',
      'END_VAR',
    ].join('\n');
    expect(parseVarNames(text)).toEqual(['iCount', 'bRun']);
  });
});

describe('parseVarDecls', () => {
  it('returns name + declared type per decl', () => {
    const text = [
      'PROGRAM PLC_PRG',
      'VAR',
      '  counter : INT := 0;',
      '  bRunning : BOOL;',
      '  fb : FB_Test;',
      'END_VAR',
    ].join('\n');
    expect(parseVarDecls(text)).toEqual([
      { name: 'counter', type: 'INT' },
      { name: 'bRunning', type: 'BOOL' },
      { name: 'fb', type: 'FB_Test' },
    ]);
  });

  it('strips ARRAY [...] OF wrapper', () => {
    const text = ['VAR', '  buf : ARRAY [0..9] OF INT;', 'END_VAR'].join('\n');
    expect(parseVarDecls(text)).toEqual([{ name: 'buf', type: 'INT' }]);
  });

  it('strips POINTER TO and REFERENCE TO', () => {
    const text = [
      'VAR',
      '  p : POINTER TO BOOL;',
      '  r : REFERENCE TO MyStruct;',
      'END_VAR',
    ].join('\n');
    expect(parseVarDecls(text)).toEqual([
      { name: 'p', type: 'BOOL' },
      { name: 'r', type: 'MyStruct' },
    ]);
  });

  it('handles AT %loc prefix', () => {
    const text = ['VAR', '  bRelay AT %QX0.1 : BOOL := FALSE;', 'END_VAR'].join('\n');
    expect(parseVarDecls(text)).toEqual([{ name: 'bRelay', type: 'BOOL' }]);
  });

  it('returns type=null when there is no `: <type>` clause on the line', () => {
    // Pathological: missing type. Don't crash; just emit name with null type.
    const text = ['VAR', '  weird;', 'END_VAR'].join('\n');
    expect(parseVarDecls(text)).toEqual([{ name: 'weird', type: null }]);
  });

  it('extracts name/type past Chinese // and (* *) comments untouched', () => {
    // Regression: the comment-stripping pre-pass must not eat the
    // following decl line. Mixed Chinese line comments and block
    // comments interleaved with normal decls should produce only the
    // real decls.
    const text = [
      'PROGRAM PLC_PRG',
      'VAR',
      '  // 计数器',
      '  iCount : INT := 0;',
      '  (* 电机状态机 *)',
      '  fbMotor : FB_Motor;',
      'END_VAR',
    ].join('\n');
    expect(parseVarDecls(text)).toEqual([
      { name: 'iCount', type: 'INT' },
      { name: 'fbMotor', type: 'FB_Motor' },
    ]);
  });
});
