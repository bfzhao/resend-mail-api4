import { nowSec } from './util';

/**
 * Sessions and passwords (the authentication foundation for the setup wizard).
 *
 * Everything is based on WebCrypto (natively available in both Workers and Node), pulling in no dependencies:
 *   - Password: PBKDF2-SHA256 (100k iterations) salted derivation, stored as `pbkdf2$iterations$salt$hash` (base64).
 *   - Session: an HMAC-SHA256-signed stateless token (`payload.sig`, both base64url), placed in an HttpOnly cookie.
 *     The secret is randomly generated when the wizard first creates an admin and stored in the user's own app_config (never in env, never passed on).
 */

export const SESSION_COOKIE = 'mail_session';
const PBKDF2_ITERATIONS = 100_000;
export const SESSION_TTL_SEC = 30 * 24 * 60 * 60; // 30 days

function bytesToB64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function b64url(bytes: Uint8Array): string {
  return bytesToB64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlToBytes(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  return b64ToBytes(s.replace(/-/g, '+').replace(/_/g, '/') + pad);
}

/** Cryptographically random hex string (for session_secret etc.). */
export function randomHex(byteLen = 32): string {
  const b = new Uint8Array(byteLen);
  crypto.getRandomValues(b);
  let out = '';
  for (let i = 0; i < b.length; i++) out += b[i].toString(16).padStart(2, '0');
  return out;
}

async function pbkdf2Bits(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations, hash: 'SHA-256' }, key, 256);
  return new Uint8Array(bits);
}

export async function hashPassword(password: string): Promise<string> {
  const salt = new Uint8Array(16);
  crypto.getRandomValues(salt);
  const bits = await pbkdf2Bits(password, salt, PBKDF2_ITERATIONS);
  return `pbkdf2$${PBKDF2_ITERATIONS}$${bytesToB64(salt)}$${bytesToB64(bits)}`;
}

/** Constant-time comparison, avoiding information leaks from an early bytewise return. */
function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = (stored || '').split('$');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2') return false;
  const iterations = Number(parts[1]);
  if (!Number.isFinite(iterations) || iterations <= 0) return false;
  let salt: Uint8Array;
  let expected: Uint8Array;
  try {
    salt = b64ToBytes(parts[2]);
    expected = b64ToBytes(parts[3]);
  } catch {
    return false;
  }
  const bits = await pbkdf2Bits(password, salt, iterations);
  return timingSafeEqual(bits, expected);
}

async function hmacSign(secret: string, data: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data)));
}

export async function signSession(secret: string, userId: string, ttlSec = SESSION_TTL_SEC): Promise<string> {
  const payload = b64url(new TextEncoder().encode(JSON.stringify({ uid: userId, exp: nowSec() + ttlSec })));
  const sig = await hmacSign(secret, payload);
  return `${payload}.${b64url(sig)}`;
}

/** Validate the signature and expiry; return userId if valid, otherwise null. */
export async function verifySession(secret: string, token: string | null): Promise<string | null> {
  if (!secret || !token) return null;
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return null;
  const payload = token.slice(0, dot);
  const expected = await hmacSign(secret, payload);
  let given: Uint8Array;
  try {
    given = b64urlToBytes(token.slice(dot + 1));
  } catch {
    return null;
  }
  if (!timingSafeEqual(expected, given)) return null;
  try {
    const obj = JSON.parse(new TextDecoder().decode(b64urlToBytes(payload))) as { uid?: unknown; exp?: unknown };
    if (typeof obj.uid !== 'string' || typeof obj.exp !== 'number' || obj.exp < nowSec()) return null;
    return obj.uid;
  } catch {
    return null;
  }
}

export function parseCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i === -1) continue;
    if (part.slice(0, i).trim() === name) {
      try {
        return decodeURIComponent(part.slice(i + 1).trim());
      } catch {
        return null;
      }
    }
  }
  return null;
}

export function sessionCookie(token: string, maxAgeSec: number): string {
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeSec}`;
}

export function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}
