import type { FastifyReply, FastifyRequest, preHandlerHookHandler } from 'fastify';
import { env } from '../config/env.js';
import { getRadioStore } from '../services/radioStore.service.js';
import type { RadioUser, UserRole } from '../services/radioStore.service.js';
import { verifyPassword } from '../services/password.service.js';

export const SESSION_COOKIE = 'imperialradio_session';
export const SESSION_TTL_MS = 14 * 24 * 60 * 60 * 1000;

const failedLogins = new Map<string, { count: number; resetAt: number }>();
let rateLimitLookups = 0;

function getCookie(request: FastifyRequest, name: string): string | null {
  const cookies = request.headers.cookie?.split(';') ?? [];
  for (const cookie of cookies) {
    const separator = cookie.indexOf('=');
    if (separator < 0 || cookie.slice(0, separator).trim() !== name) continue;
    try {
      return decodeURIComponent(cookie.slice(separator + 1).trim());
    } catch {
      return null;
    }
  }
  return null;
}

export async function authenticate(request: FastifyRequest): Promise<RadioUser | null> {
  const token = getCookie(request, SESSION_COOKIE);
  return token ? getRadioStore().getSessionUser(token) : null;
}

export function requireRoles(...roles: UserRole[]): preHandlerHookHandler {
  return async (request, reply) => {
    const user = await authenticate(request);
    if (!user) {
      reply.code(401).send({ ok: false, error: 'unauthorized' });
      return;
    }
    if (!roles.includes(user.role)) {
      reply.code(403).send({ ok: false, error: 'forbidden' });
      return;
    }
    request.radioUser = user;
  };
}

export function setSessionCookie(reply: FastifyReply, token: string): void {
  const attributes = [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`
  ];
  if (env.NODE_ENV === 'production') attributes.push('Secure');
  reply.header('Set-Cookie', attributes.join('; '));
}

export function clearSessionCookie(reply: FastifyReply): void {
  const attributes = [`${SESSION_COOKIE}=`, 'Path=/', 'HttpOnly', 'SameSite=Strict', 'Max-Age=0'];
  if (env.NODE_ENV === 'production') attributes.push('Secure');
  reply.header('Set-Cookie', attributes.join('; '));
}

export async function login(username: string, password: string): Promise<{ user: RadioUser; token: string } | null> {
  const record = getRadioStore().findActiveUserByUsername(username);
  if (!record || !(await verifyPassword(password, record.passwordHash))) return null;
  const { passwordHash: _passwordHash, ...user } = record;
  return { user, token: getRadioStore().createSession(user.id, SESSION_TTL_MS) };
}

export function checkLoginRateLimit(ip: string): boolean {
  const now = Date.now();
  rateLimitLookups += 1;
  if (rateLimitLookups % 128 === 0) {
    for (const [key, value] of failedLogins) {
      if (value.resetAt <= now) failedLogins.delete(key);
    }
  }
  const current = failedLogins.get(ip);
  if (!current || current.resetAt <= now) {
    if (!current && failedLogins.size >= 10_000) return false;
    failedLogins.set(ip, { count: 0, resetAt: now + 15 * 60 * 1000 });
    return true;
  }
  return current.count < 10;
}

export function recordLoginFailure(ip: string): void {
  const current = failedLogins.get(ip);
  if (current && current.resetAt > Date.now()) current.count += 1;
  else failedLogins.set(ip, { count: 1, resetAt: Date.now() + 15 * 60 * 1000 });
}

export function clearLoginFailures(ip: string): void {
  failedLogins.delete(ip);
}
