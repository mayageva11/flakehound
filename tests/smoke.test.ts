import { describe, expect, it } from 'vitest';
import { VERSION } from '../src/index.js';

describe('scaffold', () => {
  it('exposes the package version', () => {
    expect(VERSION).toBe('0.1.0');
  });
});
