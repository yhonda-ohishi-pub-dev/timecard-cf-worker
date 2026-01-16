// 認証ミドルウェア

import type { Env, AuthResult, SessionPayload } from './types';
import { verifyCfAccessJwt } from './cf-access';
import { verifySessionCookie } from './session';

// 認証不要のパス
const PUBLIC_PATHS = [
  '/login',
  '/login/page',
  '/login/google',
  '/login/lineworks',
  '/login/lineworks/app',
  '/login/woff',
  '/auth/google/callback',
  '/auth/lineworks/callback',
  '/auth/woff/callback',
  '/logout',
  '/sw.js',
  '/manifest.webmanifest',
  '/icon-192.png',
  '/icon-512.png',
  '/api/broadcast', // バックエンドからのpush用
  '/api/auth/check', // JS認証チェック用
];

export function isPublicPath(path: string): boolean {
  return PUBLIC_PATHS.some((p) => path === p || path.startsWith(p + '?'));
}

export async function authMiddleware(
  request: Request,
  env: Env
): Promise<AuthResult> {
  // 1. Cloudflare Access JWT確認（最優先）
  const cfUser = await verifyCfAccessJwt(request, env);
  if (cfUser) {
    return { authenticated: true, user: cfUser };
  }

  // 2. セッションCookie確認
  const sessionUser = await verifySessionCookie(request, env);
  if (sessionUser) {
    return { authenticated: true, user: sessionUser };
  }

  // 3. 未認証
  return { authenticated: false };
}

export function createLoginRedirect(request: Request): Response {
  const url = new URL(request.url);
  const loginUrl = new URL('/login', url.origin);
  loginUrl.searchParams.set('redirect', url.pathname + url.search);

  return new Response(null, {
    status: 302,
    headers: { Location: loginUrl.toString() },
  });
}
