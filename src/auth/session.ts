// セッション管理（JWT Cookie）

import * as jose from 'jose';
import type { Env, SessionPayload } from './types';

const SESSION_COOKIE_NAME = 'tc_session';
const SESSION_DURATION = 24 * 60 * 60; // 24時間

export async function createSessionCookie(
  payload: Omit<SessionPayload, 'iat' | 'exp'>,
  env: Env
): Promise<string> {
  const secret = new TextEncoder().encode(env.JWT_SECRET);
  const now = Math.floor(Date.now() / 1000);

  const jwt = await new jose.SignJWT({
    sub: payload.sub,
    email: payload.email,
    name: payload.name,
    provider: payload.provider,
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt(now)
    .setExpirationTime(now + SESSION_DURATION)
    .sign(secret);

  return `${SESSION_COOKIE_NAME}=${jwt}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_DURATION}`;
}

export async function verifySessionCookie(
  request: Request,
  env: Env
): Promise<SessionPayload | null> {
  const cookieHeader = request.headers.get('Cookie');
  if (!cookieHeader) return null;

  const cookies = parseCookies(cookieHeader);
  const token = cookies[SESSION_COOKIE_NAME];
  if (!token) return null;

  try {
    const secret = new TextEncoder().encode(env.JWT_SECRET);
    // 署名のみ検証、有効期限はチェックしない
    const { payload } = await jose.jwtVerify(token, secret, {
      currentDate: new Date(0), // 1970年に設定して期限切れを回避
    });

    return {
      sub: payload.sub as string,
      email: payload.email as string,
      name: payload.name as string,
      provider: payload.provider as SessionPayload['provider'],
      iat: payload.iat as number,
      exp: payload.exp as number,
    };
  } catch {
    return null;
  }
}

export function clearSessionCookie(): string {
  return `${SESSION_COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

function parseCookies(cookieHeader: string): Record<string, string> {
  const cookies: Record<string, string> = {};
  for (const pair of cookieHeader.split(';')) {
    const [key, ...valueParts] = pair.trim().split('=');
    if (key) {
      cookies[key] = valueParts.join('=');
    }
  }
  return cookies;
}

// OAuth state用のCookie（短期間）
export function createStateCookie(state: string): string {
  return `oauth_state=${state}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600`;
}

export function getStateCookie(request: Request): string | null {
  const cookieHeader = request.headers.get('Cookie');
  if (!cookieHeader) return null;
  const cookies = parseCookies(cookieHeader);
  return cookies['oauth_state'] || null;
}

export function clearStateCookie(): string {
  return `oauth_state=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

// 一時トークン（外部ブラウザ遷移用、5分間有効）
const TEMP_TOKEN_DURATION = 5 * 60; // 5分

export async function createTempToken(
  payload: Omit<SessionPayload, 'iat' | 'exp'>,
  env: Env
): Promise<string> {
  const secret = new TextEncoder().encode(env.JWT_SECRET);
  const now = Math.floor(Date.now() / 1000);

  const jwt = await new jose.SignJWT({
    sub: payload.sub,
    email: payload.email,
    name: payload.name,
    provider: payload.provider,
    type: 'temp', // 一時トークンであることを示す
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt(now)
    .setExpirationTime(now + TEMP_TOKEN_DURATION)
    .sign(secret);

  return jwt;
}

export async function verifyTempToken(
  token: string,
  env: Env
): Promise<Omit<SessionPayload, 'iat' | 'exp'> | null> {
  try {
    const secret = new TextEncoder().encode(env.JWT_SECRET);
    const { payload } = await jose.jwtVerify(token, secret);

    // 一時トークンかどうか確認
    if (payload.type !== 'temp') {
      return null;
    }

    return {
      sub: payload.sub as string,
      email: payload.email as string,
      name: payload.name as string,
      provider: payload.provider as SessionPayload['provider'],
    };
  } catch {
    return null;
  }
}
