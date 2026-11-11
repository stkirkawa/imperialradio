import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';
import { env } from '../config/env.js';
import { hashPassword } from './password.service.js';

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');

export type UserRole = 'superadmin' | 'dj';

export type RadioUser = {
  id: string;
  username: string;
  displayName: string;
  role: UserRole;
  active: boolean;
  createdAt: string;
};

export type SessionUser = RadioUser & {
  sessionToken: string;
};

export type Playlist = {
  id: string;
  name: string;
  tracks: string[];
  createdAt: string;
  updatedAt: string;
};

export type OnAirState = {
  djId: string;
  djUsername: string;
  djDisplayName: string;
  startedAt: string;
  playlistId: string | null;
  sourceMode: 'playlist' | 'rtmp' | 'icecast' | 'microphone';
  mediaPath: string | null;
  microphonePath: string | null;
  microphoneEnabled: boolean;
  volume: number;
};

type UserRow = {
  id: string;
  username: string;
  display_name: string;
  role: UserRole;
  active: number;
  created_at: string;
  password_hash: string;
};

type PublicUserRow = {
  id: string;
  username: string;
  display_name: string;
  role: UserRole;
  active: number;
  created_at: string;
};

type SessionRow = PublicUserRow;

function mapUser(row: PublicUserRow): RadioUser {
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    role: row.role,
    active: row.active === 1,
    createdAt: row.created_at
  };
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function makeId(): string {
  return randomBytes(18).toString('base64url');
}

export class RadioStore {
  private readonly db: DatabaseSyncType;
  private sessionsCreatedSinceCleanup = 0;

  constructor(databasePath = path.join(env.DATA_DIR, 'radio.sqlite')) {
    this.db = new DatabaseSync(databasePath);
    this.db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');
  }

  async initialize(): Promise<OnAirState | null> {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL COLLATE NOCASE UNIQUE,
        display_name TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('superadmin', 'dj')),
        password_hash TEXT NOT NULL,
        active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS sessions (
        token_hash TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        expires_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);

      CREATE TABLE IF NOT EXISTS playlists (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (user_id, name)
      );

      CREATE TABLE IF NOT EXISTS playlist_tracks (
        playlist_id TEXT NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
        position INTEGER NOT NULL,
        filename TEXT NOT NULL,
        PRIMARY KEY (playlist_id, position)
      );

      CREATE TABLE IF NOT EXISTS radio_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        dj_id TEXT REFERENCES users(id) ON DELETE SET NULL,
        started_at TEXT,
        playlist_id TEXT,
        lease_id TEXT,
        source_mode TEXT NOT NULL DEFAULT 'playlist',
        media_path TEXT,
        microphone_path TEXT,
        microphone_enabled INTEGER NOT NULL DEFAULT 0 CHECK (microphone_enabled IN (0, 1)),
        output_volume INTEGER NOT NULL DEFAULT 100 CHECK (output_volume BETWEEN 0 AND 100)
      );

      CREATE TABLE IF NOT EXISTS dj_live_queue (
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        position INTEGER NOT NULL,
        filename TEXT NOT NULL,
        PRIMARY KEY (user_id, position)
      );

      CREATE TABLE IF NOT EXISTS broadcast_credentials (
        user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        token_hash TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      INSERT OR IGNORE INTO radio_state (id) VALUES (1);
    `);

    const radioStateColumns = this.db.prepare('PRAGMA table_info(radio_state)').all() as Array<{ name: string }>;
    if (!radioStateColumns.some((column) => column.name === 'source_mode')) {
      this.db.exec("ALTER TABLE radio_state ADD COLUMN source_mode TEXT NOT NULL DEFAULT 'playlist'");
    }
    if (!radioStateColumns.some((column) => column.name === 'media_path')) {
      this.db.exec('ALTER TABLE radio_state ADD COLUMN media_path TEXT');
    }
    if (!radioStateColumns.some((column) => column.name === 'microphone_path')) {
      this.db.exec('ALTER TABLE radio_state ADD COLUMN microphone_path TEXT');
    }
    if (!radioStateColumns.some((column) => column.name === 'microphone_enabled')) {
      this.db.exec('ALTER TABLE radio_state ADD COLUMN microphone_enabled INTEGER NOT NULL DEFAULT 0');
    }
    if (!radioStateColumns.some((column) => column.name === 'output_volume')) {
      this.db.exec('ALTER TABLE radio_state ADD COLUMN output_volume INTEGER NOT NULL DEFAULT 100');
    }

    const previousOnAir = this.getOnAir();
    this.db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(Date.now());
    this.db.prepare('DELETE FROM broadcast_credentials').run();
    this.db.prepare('DELETE FROM dj_live_queue').run();
    this.db.prepare(`
      UPDATE radio_state
      SET dj_id = NULL, started_at = NULL, playlist_id = NULL, lease_id = NULL,
          source_mode = 'playlist', media_path = NULL, microphone_path = NULL,
          microphone_enabled = 0, output_volume = 100
      WHERE id = 1
    `).run();

    const adminCount = this.db.prepare("SELECT COUNT(*) AS count FROM users WHERE role = 'superadmin'").get();
    if (Number(adminCount?.count ?? 0) === 0 && env.ADMIN_USER && env.ADMIN_PASS && env.ADMIN_PASS !== 'change_me') {
      const passwordHash = await hashPassword(env.ADMIN_PASS);
      const insertAdmin = this.db.prepare(`
        INSERT OR IGNORE INTO users (id, username, display_name, role, password_hash, active, created_at)
        VALUES (?, ?, ?, 'superadmin', ?, 1, ?)
      `);
      insertAdmin.run(makeId(), env.ADMIN_USER, env.ADMIN_USER, passwordHash, new Date().toISOString());
    }
    return previousOnAir;
  }

  close(): void {
    this.db.close();
  }

  findActiveUserByUsername(username: string): (RadioUser & { passwordHash: string }) | null {
    const row = this.db.prepare(`
      SELECT id, username, display_name, role, active, created_at, password_hash
      FROM users WHERE username = ? COLLATE NOCASE AND active = 1
    `).get(username) as UserRow | undefined;
    return row ? { ...mapUser(row), passwordHash: row.password_hash } : null;
  }

  createSession(userId: string, ttlMs: number): string {
    if (++this.sessionsCreatedSinceCleanup >= 100) {
      this.db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(Date.now());
      this.sessionsCreatedSinceCleanup = 0;
    }
    const token = randomBytes(32).toString('base64url');
    this.db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)')
      .run(hashToken(token), userId, Date.now() + ttlMs);
    return token;
  }

  getSessionUser(token: string): RadioUser | null {
    const row = this.db.prepare(`
      SELECT u.id, u.username, u.display_name, u.role, u.active, u.created_at
      FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ? AND s.expires_at > ?
    `).get(hashToken(token), Date.now()) as SessionRow | undefined;
    return row && row.active === 1 ? mapUser(row) : null;
  }

  deleteSession(token: string): void {
    this.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token));
  }

  listDjs(): RadioUser[] {
    const rows = this.db.prepare(`
      SELECT id, username, display_name, role, active, created_at
      FROM users WHERE role = 'dj' ORDER BY username COLLATE NOCASE
    `).all() as PublicUserRow[];
    return rows.map(mapUser);
  }

  async createDj(input: { username: string; displayName: string; password: string }): Promise<RadioUser> {
    const id = makeId();
    const now = new Date().toISOString();
    const passwordHash = await hashPassword(input.password);
    this.db.prepare(`
      INSERT INTO users (id, username, display_name, role, password_hash, active, created_at)
      VALUES (?, ?, ?, 'dj', ?, 1, ?)
    `).run(id, input.username, input.displayName, passwordHash, now);
    return this.getUserById(id)!;
  }

  getUserById(id: string): RadioUser | null {
    const row = this.db.prepare(`
      SELECT id, username, display_name, role, active, created_at
      FROM users WHERE id = ?
    `).get(id) as PublicUserRow | undefined;
    return row ? mapUser(row) : null;
  }

  async updateDj(id: string, input: { displayName?: string; active?: boolean; password?: string }): Promise<RadioUser | null> {
    const user = this.getUserById(id);
    if (!user || user.role !== 'dj') return null;

    if (input.displayName !== undefined || input.active !== undefined) {
      this.db.prepare(`
        UPDATE users
        SET display_name = COALESCE(?, display_name), active = COALESCE(?, active)
        WHERE id = ? AND role = 'dj'
      `).run(input.displayName ?? null, input.active === undefined ? null : Number(input.active), id);
    }

    if (input.password) {
      const passwordHash = await hashPassword(input.password);
      this.db.prepare('UPDATE users SET password_hash = ? WHERE id = ? AND role = \'dj\'').run(passwordHash, id);
      this.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
      this.revokeBroadcastToken(id);
      this.releaseLive(id);
    }

    if (input.active === false) {
      this.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
      this.revokeBroadcastToken(id);
      this.releaseLive(id);
    }

    return this.getUserById(id);
  }

  listPlaylists(userId: string): Playlist[] {
    const rows = this.db.prepare(`
      SELECT id, name, created_at, updated_at
      FROM playlists WHERE user_id = ? ORDER BY updated_at DESC
    `).all(userId) as Array<{ id: string; name: string; created_at: string; updated_at: string }>;

    const getTracks = this.db.prepare(`
      SELECT filename FROM playlist_tracks WHERE playlist_id = ? ORDER BY position
    `);

    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      tracks: (getTracks.all(row.id) as Array<{ filename: string }>).map((track) => track.filename),
      createdAt: row.created_at,
      updatedAt: row.updated_at
    }));
  }

  getPlaylist(userId: string, playlistId: string): Playlist | null {
    const row = this.db.prepare(`
      SELECT id, name, created_at, updated_at FROM playlists
      WHERE user_id = ? AND id = ?
    `).get(userId, playlistId) as { id: string; name: string; created_at: string; updated_at: string } | undefined;
    if (!row) return null;
    const tracks = this.db.prepare(`
      SELECT filename FROM playlist_tracks WHERE playlist_id = ? ORDER BY position
    `).all(playlistId) as Array<{ filename: string }>;
    return { id: row.id, name: row.name, tracks: tracks.map((item) => item.filename),
      createdAt: row.created_at, updatedAt: row.updated_at };
  }

  createPlaylist(userId: string, name: string): Playlist {
    const id = makeId();
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO playlists (id, user_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
    `).run(id, userId, name, now, now);
    return { id, name, tracks: [], createdAt: now, updatedAt: now };
  }

  deletePlaylist(userId: string, playlistId: string): boolean {
    return this.db.prepare('DELETE FROM playlists WHERE id = ? AND user_id = ?').run(playlistId, userId).changes === 1;
  }

  addPlaylistTrack(userId: string, playlistId: string, filename: string): Playlist | null {
    const playlist = this.getPlaylist(userId, playlistId);
    if (!playlist) return null;
    this.db.prepare(`
      INSERT INTO playlist_tracks (playlist_id, position, filename) VALUES (?, ?, ?)
    `).run(playlistId, playlist.tracks.length, filename);
    this.db.prepare('UPDATE playlists SET updated_at = ? WHERE id = ?').run(new Date().toISOString(), playlistId);
    return this.getPlaylist(userId, playlistId);
  }

  removePlaylistTrack(userId: string, playlistId: string, position: number): Playlist | null {
    const playlist = this.getPlaylist(userId, playlistId);
    if (!playlist || !Number.isInteger(position) || position < 0 || position >= playlist.tracks.length) return null;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('DELETE FROM playlist_tracks WHERE playlist_id = ? AND position = ?').run(playlistId, position);
      this.db.prepare('UPDATE playlist_tracks SET position = position - 1 WHERE playlist_id = ? AND position > ?').run(playlistId, position);
      this.db.prepare('UPDATE playlists SET updated_at = ? WHERE id = ?').run(new Date().toISOString(), playlistId);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return this.getPlaylist(userId, playlistId);
  }

  getOnAir(): OnAirState | null {
    const row = this.db.prepare(`
      SELECT r.dj_id, r.started_at, r.playlist_id, r.source_mode, r.media_path,
             r.microphone_path, r.microphone_enabled, r.output_volume, u.username, u.display_name
      FROM radio_state r JOIN users u ON u.id = r.dj_id
      WHERE r.id = 1 AND r.dj_id IS NOT NULL AND u.active = 1
    `).get() as {
      dj_id: string;
      started_at: string;
      playlist_id: string | null;
      source_mode: 'playlist' | 'rtmp' | 'icecast' | 'microphone';
      media_path: string | null;
      microphone_path: string | null;
      microphone_enabled: number;
      output_volume: number;
      username: string;
      display_name: string;
    } | undefined;
    if (!row) return null;
    return {
      djId: row.dj_id,
      djUsername: row.username,
      djDisplayName: row.display_name,
      startedAt: row.started_at,
      playlistId: row.playlist_id,
      sourceMode: row.source_mode,
      mediaPath: row.media_path,
      microphonePath: row.microphone_path,
      microphoneEnabled: row.microphone_enabled === 1,
      volume: row.output_volume
    };
  }

  claimLive(
    userId: string,
    playlistId: string | null,
    sourceMode: OnAirState['sourceMode'] = 'playlist',
    mediaPath: string | null = null
  ): { ok: true; leaseId: string; onAir: OnAirState } | { ok: false; onAir: OnAirState | null } {
    const user = this.getUserById(userId);
    if (!user || user.role !== 'dj' || !user.active) return { ok: false, onAir: this.getOnAir() };
    if (sourceMode === 'playlist' && playlistId && !this.getPlaylist(userId, playlistId)) return { ok: false, onAir: this.getOnAir() };

    const leaseId = makeId();
    const startedAt = new Date().toISOString();
    const result = this.db.prepare(`
      UPDATE radio_state
      SET dj_id = ?, started_at = ?, playlist_id = ?, lease_id = ?, source_mode = ?, media_path = ?,
          microphone_path = NULL, microphone_enabled = 0, output_volume = 100
      WHERE id = 1 AND dj_id IS NULL
    `).run(userId, startedAt, sourceMode === 'playlist' ? playlistId : null, leaseId, sourceMode, mediaPath);
    if (result.changes !== 1) return { ok: false, onAir: this.getOnAir() };
    return {
      ok: true,
      leaseId,
      onAir: {
        djId: user.id,
        djUsername: user.username,
        djDisplayName: user.displayName,
        startedAt,
        playlistId: sourceMode === 'playlist' ? playlistId : null,
        sourceMode,
        mediaPath,
        microphonePath: null,
        microphoneEnabled: false,
        volume: 100
      }
    };
  }

  releaseLive(userId: string, leaseId?: string): boolean {
    const result = leaseId
      ? this.db.prepare("UPDATE radio_state SET dj_id = NULL, started_at = NULL, playlist_id = NULL, lease_id = NULL, source_mode = 'playlist', media_path = NULL, microphone_path = NULL, microphone_enabled = 0, output_volume = 100 WHERE id = 1 AND dj_id = ? AND lease_id = ?").run(userId, leaseId)
      : this.db.prepare("UPDATE radio_state SET dj_id = NULL, started_at = NULL, playlist_id = NULL, lease_id = NULL, source_mode = 'playlist', media_path = NULL, microphone_path = NULL, microphone_enabled = 0, output_volume = 100 WHERE id = 1 AND dj_id = ?").run(userId);
    if (result.changes === 1) this.clearDjQueue(userId);
    return result.changes === 1;
  }

  releaseLiveByAdmin(): boolean {
    const userId = this.getOnAir()?.djId;
    const released = this.db.prepare("UPDATE radio_state SET dj_id = NULL, started_at = NULL, playlist_id = NULL, lease_id = NULL, source_mode = 'playlist', media_path = NULL, microphone_path = NULL, microphone_enabled = 0, output_volume = 100 WHERE id = 1 AND dj_id IS NOT NULL").run().changes === 1;
    if (released && userId) this.clearDjQueue(userId);
    return released;
  }

  setLiveMediaPath(userId: string, mediaPath: string): boolean {
    return this.db.prepare(`
      UPDATE radio_state SET media_path = ?
      WHERE id = 1 AND dj_id = ? AND source_mode IN ('rtmp', 'icecast', 'microphone')
    `).run(mediaPath, userId).changes === 1;
  }

  setMicrophonePath(userId: string, mediaPath: string): boolean {
    return this.db.prepare(`
      UPDATE radio_state SET microphone_path = ?, microphone_enabled = 1
      WHERE id = 1 AND dj_id = ? AND source_mode = 'playlist' AND microphone_path IS NULL
    `).run(mediaPath, userId).changes === 1;
  }

  clearMicrophone(userId: string): string | null {
    const path = this.db.prepare(`
      SELECT microphone_path FROM radio_state WHERE id = 1 AND dj_id = ?
    `).get(userId) as { microphone_path: string | null } | undefined;
    if (!path) return null;
    this.db.prepare(`
      UPDATE radio_state SET microphone_path = NULL, microphone_enabled = 0
      WHERE id = 1 AND dj_id = ?
    `).run(userId);
    return path.microphone_path;
  }

  setMicrophoneEnabled(userId: string, enabled: boolean): boolean {
    return this.db.prepare(`
      UPDATE radio_state SET microphone_enabled = ?
      WHERE id = 1 AND dj_id = ? AND source_mode = 'playlist' AND microphone_path IS NOT NULL
    `).run(Number(enabled), userId).changes === 1;
  }

  setLiveVolume(userId: string, volume: number): boolean {
    if (!Number.isInteger(volume) || volume < 0 || volume > 100) return false;
    return this.db.prepare(`
      UPDATE radio_state SET output_volume = ? WHERE id = 1 AND dj_id = ?
    `).run(volume, userId).changes === 1;
  }

  replaceDjQueue(userId: string, tracks: string[]): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('DELETE FROM dj_live_queue WHERE user_id = ?').run(userId);
      const insert = this.db.prepare('INSERT INTO dj_live_queue (user_id, position, filename) VALUES (?, ?, ?)');
      tracks.forEach((filename, position) => insert.run(userId, position, filename));
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  listDjQueue(userId: string): string[] {
    const rows = this.db.prepare(`
      SELECT filename FROM dj_live_queue WHERE user_id = ? ORDER BY position
    `).all(userId) as Array<{ filename: string }>;
    return rows.map((row) => row.filename);
  }

  addDjQueueTrack(userId: string, filename: string): string[] {
    const position = this.db.prepare(`
      SELECT COALESCE(MAX(position) + 1, 0) AS position FROM dj_live_queue WHERE user_id = ?
    `).get(userId) as { position: number };
    this.db.prepare('INSERT INTO dj_live_queue (user_id, position, filename) VALUES (?, ?, ?)')
      .run(userId, position.position, filename);
    return this.listDjQueue(userId);
  }

  moveDjQueueTrack(userId: string, from: number, to: number): string[] | null {
    const tracks = this.listDjQueue(userId);
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || from >= tracks.length || to < 0 || to >= tracks.length) {
      return null;
    }
    const [track] = tracks.splice(from, 1);
    tracks.splice(to, 0, track);
    this.replaceDjQueue(userId, tracks);
    return tracks;
  }

  removeDjQueueTrack(userId: string, position: number): string[] | null {
    const tracks = this.listDjQueue(userId);
    if (!Number.isInteger(position) || position < 0 || position >= tracks.length) return null;
    tracks.splice(position, 1);
    this.replaceDjQueue(userId, tracks);
    return tracks;
  }

  consumeDjQueueThrough(userId: string, filename: string): void {
    const tracks = this.listDjQueue(userId);
    const position = tracks.indexOf(filename);
    if (position >= 0) this.replaceDjQueue(userId, tracks.slice(position + 1));
  }

  clearDjQueue(userId: string): void {
    this.db.prepare('DELETE FROM dj_live_queue WHERE user_id = ?').run(userId);
  }

  setBroadcastToken(userId: string, token: string): void {
    this.db.prepare(`
      INSERT INTO broadcast_credentials (user_id, token_hash, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET token_hash = excluded.token_hash, updated_at = excluded.updated_at
    `).run(userId, hashToken(token), new Date().toISOString());
  }

  revokeBroadcastToken(userId: string): void {
    this.db.prepare('DELETE FROM broadcast_credentials WHERE user_id = ?').run(userId);
  }

  verifyBroadcastToken(username: string, token: string): RadioUser | null {
    const row = this.db.prepare(`
      SELECT u.id, u.username, u.display_name, u.role, u.active, u.created_at, b.token_hash
      FROM users u JOIN broadcast_credentials b ON b.user_id = u.id
      WHERE u.username = ? COLLATE NOCASE AND u.role = 'dj' AND u.active = 1
    `).get(username) as (PublicUserRow & { token_hash: string }) | undefined;
    if (!row) return null;
    const expected = Buffer.from(row.token_hash, 'hex');
    const actual = Buffer.from(hashToken(token), 'hex');
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
    return mapUser(row);
  }

  verifyLiveBroadcastToken(token: string): RadioUser | null {
    const onAir = this.getOnAir();
    if (!onAir || !['icecast', 'rtmp', 'microphone'].includes(onAir.sourceMode)) return null;
    const row = this.db.prepare(`
      SELECT u.id, u.username, u.display_name, u.role, u.active, u.created_at, b.token_hash
      FROM users u JOIN broadcast_credentials b ON b.user_id = u.id
      WHERE u.id = ? AND u.role = 'dj' AND u.active = 1
    `).get(onAir.djId) as (PublicUserRow & { token_hash: string }) | undefined;
    if (!row) return null;
    const expected = Buffer.from(row.token_hash, 'hex');
    const actual = Buffer.from(hashToken(token), 'hex');
    return expected.length === actual.length && timingSafeEqual(expected, actual) ? mapUser(row) : null;
  }
}

let activeStore: RadioStore | null = null;

export async function initializeRadioStore(): Promise<{ store: RadioStore; previousOnAir: OnAirState | null }> {
  if (activeStore) return { store: activeStore, previousOnAir: null };
  const databasePath = path.join(env.DATA_DIR, 'radio.sqlite');
  await fs.mkdir(path.dirname(databasePath), { recursive: true });
  const store = new RadioStore(databasePath);
  const previousOnAir = await store.initialize();
  activeStore = store;
  return { store, previousOnAir };
}

export function getRadioStore(): RadioStore {
  if (!activeStore) throw new Error('Radio store has not been initialized');
  return activeStore;
}

/** Release the SQLite connection after all radio-related work has stopped. */
export function closeRadioStore(): void {
  if (!activeStore) return;
  activeStore.close();
  activeStore = null;
}
