/**
 * Server-side session validation for the Vercel edge gateway.
 *
 * Validates Clerk-issued bearer tokens using local JWT verification
 * with jose + cached JWKS. No Convex round-trip needed.
 *
 * This module must NOT import anything from `src/` -- it runs in the
 * Vercel edge runtime, not the browser.
 */

import { createRemoteJWKSet, jwtVerify } from 'jose';

// Clerk JWT issuer domain -- set in Vercel env vars
const CLERK_JWT_ISSUER_DOMAIN = process.env.CLERK_JWT_ISSUER_DOMAIN ?? '';

// Module-scope JWKS resolver -- cached across warm invocations.
// jose handles key rotation and caching internally.
let _jwks: ReturnType<typeof createRemoteJWKSet> | null = null;
function getJWKS() {
  if (!_jwks && CLERK_JWT_ISSUER_DOMAIN) {
    const jwksUrl = new URL('/.well-known/jwks.json', CLERK_JWT_ISSUER_DOMAIN);
    _jwks = createRemoteJWKSet(jwksUrl);
  }
  return _jwks;
}

export interface SessionResult {
  valid: boolean;
  userId?: string;
  role?: 'free' | 'pro';
}

/**
 * Validate a Clerk-issued bearer token using local JWKS verification.
 * Extracts `sub` (user ID) and `plan` (entitlement) from verified claims.
 * Fails closed: invalid/expired/unverifiable tokens return { valid: false }.
 */
export async function validateBearerToken(token: string): Promise<SessionResult> {
  const jwks = getJWKS();
  if (!jwks) return { valid: false };

  try {
    const { payload } = await jwtVerify(token, jwks, {
      issuer: CLERK_JWT_ISSUER_DOMAIN,
      audience: 'convex',
      algorithms: ['RS256'],
    });

    const userId = payload.sub;
    if (!userId) return { valid: false };

    // Normalize plan claim -- unknown/missing = free (never pro)
    const rawPlan = (payload as Record<string, unknown>).plan;
    const role: 'free' | 'pro' = rawPlan === 'pro' ? 'pro' : 'free';

    return { valid: true, userId, role };
  } catch {
    // Signature verification failed, expired, wrong issuer, etc.
    return { valid: false };
  }
}
