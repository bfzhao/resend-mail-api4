import type { Env } from './types';
import * as repo from './repo';
import { parseCookie, verifySession, SESSION_COOKIE } from './session';

/**
 * Authentication has two paths, pick one:
 *
 *   1) **env Basic Auth**: enabled when both API_USERNAME / API_PASSWORD are non-empty (the deploy-time compatibility path).
 *   2) **D1 session**: the path set up by the wizard. If an admin account already exists in the DB, a valid session cookie is required;
 *      if not (uninitialized), allow through — the frontend shows the setup wizard so the user can set an admin password first.
 *
 * When no auth is configured and the app is uninitialized, allow through (convenient for local dev, and historical behavior too).
 */
export async function authenticate(request: Request, env: Env): Promise<boolean> {
  const user = env.API_USERNAME;
  const pass = env.API_PASSWORD;
  if (user || pass) return checkBasic(request, user || '', pass || '');

  if (!env.DB) return true;
  try {
    const secret = await repo.getConfig(env, 'session_secret');
    if (secret) {
      const uid = await verifySession(secret, parseCookie(request.headers.get('Cookie'), SESSION_COOKIE));
      if (uid) return true;
    }
    // No admin set → treat as uninitialized, allow through (so the wizard is reachable); admin set → deny.
    return !(await repo.hasAdminUser(env));
  } catch {
    return true; // A database error should not lock the user out
  }
}

function checkBasic(request: Request, user: string, pass: string): boolean {
  const auth = request.headers.get('Authorization');
  if (!auth || !auth.startsWith('Basic ')) return false;
  try {
    const decoded = atob(auth.slice(6));
    const idx = decoded.indexOf(':');
    if (idx === -1) return false;
    return decoded.slice(0, idx) === user && decoded.slice(idx + 1) === pass;
  } catch {
    return false;
  }
}

/** Current auth mode: 'basic' (env) | 'session' (D1 admin) | 'none' (uninitialized). */
export async function authMode(env: Env): Promise<'basic' | 'session' | 'none'> {
  if (env.API_USERNAME || env.API_PASSWORD) return 'basic';
  if (!env.DB) return 'none';
  try {
    return (await repo.hasAdminUser(env)) ? 'session' : 'none';
  } catch {
    return 'none';
  }
}

/** Whether the current request is authenticated (used by /api/setup/status to tell the frontend: go straight into the app or log in first). */
export async function isAuthenticated(request: Request, env: Env): Promise<boolean> {
  if (env.API_USERNAME || env.API_PASSWORD) {
    return checkBasic(request, env.API_USERNAME || '', env.API_PASSWORD || '');
  }
  if (!env.DB) return true;
  try {
    const secret = await repo.getConfig(env, 'session_secret');
    if (!secret) return false;
    const uid = await verifySession(secret, parseCookie(request.headers.get('Cookie'), SESSION_COOKIE));
    return !!uid;
  } catch {
    return false;
  }
}

export function unauthorized(): Response {
  return new Response('Unauthorized', {
    status: 401,
    headers: { 'WWW-Authenticate': 'Basic realm="resend-inbox", charset="UTF-8"' },
  });
}
