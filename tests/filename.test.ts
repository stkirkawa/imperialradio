import { describe, it, expect } from 'vitest';
import { sanitizeFilename } from '../src/utils/sanitizeFilename.js';

describe('sanitizeFilename', () => {
  it('normalizes unsafe characters', () => {
    const res = sanitizeFilename('weird name!!.mp3');
    expect(res).toBe('weird_name_.mp3');
  });
});
