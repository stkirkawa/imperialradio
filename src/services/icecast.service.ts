import { request } from 'undici';
import { env } from '../config/env.js';
import { decodeHtmlEntities } from '../utils/decodeHtmlEntities.js';

export type NowPlaying = {
  station: string;
  title: string;
  listeners: number;
  mount: string;
  updatedAt: string;
  onAirLabel?: string;
};

export type IcecastSource = {
  listenurl?: string;
  server_name?: string;
  title?: string;
  ['display-title']?: string | null;
  metadata?: Record<string, string | null | undefined>;
  playlist?: { trackList?: { title?: string | null }[] };
  artist?: string;
  listeners?: number;
  listener_count?: number;
  mount?: string;
};

export type IcecastStatus = {
  icestats?: {
    source?: IcecastSource | IcecastSource[];
  };
};

function getAuthHeader() {
  if (!env.ICECAST_STATUS_USER || !env.ICECAST_STATUS_PASS) return undefined;
  const token = Buffer.from(`${env.ICECAST_STATUS_USER}:${env.ICECAST_STATUS_PASS}`).toString('base64');
  return `Basic ${token}`;
}

function normalizeSources(source?: IcecastSource | IcecastSource[]): IcecastSource[] {
  if (!source) return [];
  return Array.isArray(source) ? source : [source];
}

function pickSource(sources: IcecastSource[], mount: string): IcecastSource | null {
  if (sources.length === 0) return null;
  const byMount = sources.find((s) => s.mount === mount || s.listenurl?.endsWith(mount));
  return byMount ?? sources[0];
}

function resolveTitle(source?: IcecastSource | null): string {
  if (!source) return '—';
  const candidates = [
    source.title,
    source['display-title'],
    source.metadata?.x_icy_title,
    source.metadata?.icy_title,
    source.metadata?.title,
    source.playlist?.trackList?.[0]?.title
  ];
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim()) return decodeHtmlEntities(c.trim());
  }
  const combo = [source.artist, source.title].filter(Boolean).join(' — ');
  return combo.trim() || '—';
}

function resolveListeners(source?: IcecastSource | null): number {
  if (!source) return 0;
  if (typeof source.listeners === 'number') return source.listeners;
  if (typeof source.listener_count === 'number') return source.listener_count;
  return 0;
}

export function parseIcecastStatus(data: IcecastStatus, mount: string): NowPlaying {
  const sources = normalizeSources(data.icestats?.source);
  const chosen = pickSource(sources, mount);

  return {
    station: 'IMPERIAL RADIO',
    title: resolveTitle(chosen),
    listeners: resolveListeners(chosen),
    mount: chosen?.mount || mount,
    updatedAt: new Date().toISOString()
  };
}

export async function fetchNowPlaying(): Promise<NowPlaying> {
  const url = new URL(env.ICECAST_STATUS_PATH, env.ICECAST_BASE).toString();
  const auth = getAuthHeader();

  const { body, statusCode } = await request(url, {
    method: 'GET',
    headers: auth ? { authorization: auth } : undefined,
    headersTimeout: 10_000,
    bodyTimeout: 10_000
  });

  if (statusCode < 200 || statusCode >= 300) {
    body.destroy();
    throw new Error(`Icecast status error: ${statusCode}`);
  }

  const data = (await body.json()) as IcecastStatus;
  return parseIcecastStatus(data, env.ICECAST_MOUNT);
}
