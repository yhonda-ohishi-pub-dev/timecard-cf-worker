// Cloudflare Access JWT検証

import * as jose from 'jose';
import type { Env, SessionPayload } from './types';

interface CfAccessCerts {
  keys: jose.JWK[];
}

// メモリキャッシュ（Worker再起動までは保持）
let certsCache: { keys: jose.JWK[]; fetchedAt: number } | null = null;
const CACHE_DURATION = 60 * 60 * 1000; // 1時間

async function getCerts(teamName: string): Promise<jose.JWK[]> {
  const now = Date.now();

  if (certsCache && now - certsCache.fetchedAt < CACHE_DURATION) {
    return certsCache.keys;
  }

  const certsUrl = `https://${teamName}.cloudflareaccess.com/cdn-cgi/access/certs`;
  const response = await fetch(certsUrl);

  if (!response.ok) {
    throw new Error(`Failed to fetch CF Access certs: ${response.status}`);
  }

  const data = (await response.json()) as CfAccessCerts;
  certsCache = { keys: data.keys, fetchedAt: now };

  return data.keys;
}

export async function verifyCfAccessJwt(
  request: Request,
  env: Env
): Promise<SessionPayload | null> {
  const jwt = request.headers.get('CF-Access-Jwt-Assertion');
  if (!jwt) return null;

  try {
    const keys = await getCerts(env.CF_ACCESS_TEAM_NAME);
    const jwks = jose.createLocalJWKSet({ keys });

    const verifyOptions: jose.JWTVerifyOptions = {};
    if (env.CF_ACCESS_AUD) {
      verifyOptions.audience = env.CF_ACCESS_AUD;
    }

    const { payload } = await jose.jwtVerify(jwt, jwks, verifyOptions);

    return {
      sub: payload.sub as string,
      email: (payload.email as string) || '',
      name: (payload.email as string) || '', // CF Accessはnameを提供しない
      provider: 'cf_access',
      iat: payload.iat as number,
      exp: payload.exp as number,
    };
  } catch (e) {
    console.error('CF Access JWT verification failed:', e);
    return null;
  }
}
