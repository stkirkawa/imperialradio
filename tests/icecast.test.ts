import { describe, it, expect } from 'vitest';
import { parseIcecastStatus } from '../src/services/icecast.service.js';

const mount = '/radio.mp3';

describe('parseIcecastStatus', () => {
  it('handles object source', () => {
    const data = {
      icestats: {
        source: { mount, title: 'Artist — Track', listeners: 5 }
      }
    };
    const res = parseIcecastStatus(data, mount);
    expect(res.station).toBe('IMPERIAL RADIO');
    expect(res.title).toBe('Artist — Track');
    expect(res.listeners).toBe(5);
  });

  it('handles array source and picks mount', () => {
    const data = {
      icestats: {
        source: [
          { mount: '/other.mp3', title: 'Other', listeners: 1 },
          { mount, title: 'Main', listeners: 7 }
        ]
      }
    };
    const res = parseIcecastStatus(data, mount);
    expect(res.station).toBe('IMPERIAL RADIO');
    expect(res.title).toBe('Main');
    expect(res.listeners).toBe(7);
  });
});
