// Helpers for the JWT that ICA's web app sends to its APIs.

/** Returns the bearer token from a list of webRequest headers, or null. */
export function extractBearerToken(headers) {
  if (!Array.isArray(headers)) return null;
  const header = headers.find((h) => h && typeof h.name === 'string' && h.name.toLowerCase() === 'authorization');
  const match = header && typeof header.value === 'string' && header.value.match(/^Bearer\s+(\S+)$/i);
  if (!match || !looksLikeJwt(match[1])) return null;
  return match[1];
}

export function looksLikeJwt(token) {
  return typeof token === 'string' && /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$/.test(token);
}

/** Decodes the payload of a JWT without verifying it. Returns null when invalid. */
export function decodeJwtPayload(token) {
  if (!looksLikeJwt(token)) return null;
  try {
    const base64 = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}

/** Returns the expiry time in milliseconds, or null if the token has no exp claim. */
export function getTokenExpiry(token) {
  const payload = decodeJwtPayload(token);
  return payload && typeof payload.exp === 'number' ? payload.exp * 1000 : null;
}

/** True if the token is expired (with a small safety margin). Tokens without exp are treated as valid. */
export function isTokenExpired(token, now = Date.now(), marginMs = 30_000) {
  const expiry = getTokenExpiry(token);
  return expiry !== null && expiry - marginMs <= now;
}
