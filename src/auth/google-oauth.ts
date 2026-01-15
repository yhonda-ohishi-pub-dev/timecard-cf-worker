// Google OAuth 2.0

import { type Env, type GoogleOAuthConfig, type OAuthState, isEmailAllowed } from './types';
import { createSessionCookie, createStateCookie, getStateCookie, clearStateCookie } from './session';

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_USERINFO_URL = 'https://www.googleapis.com/oauth2/v2/userinfo';

function getConfig(env: Env): GoogleOAuthConfig {
  const configs = JSON.parse(env.GOOGLE_OAUTH_CONFIG) as GoogleOAuthConfig[];
  if (!configs || configs.length === 0) {
    throw new Error('GOOGLE_OAUTH_CONFIG not configured');
  }
  return configs[0]; // 最初の設定を使用
}

function getRedirectUri(request: Request): string {
  const url = new URL(request.url);
  return `${url.origin}/auth/google/callback`;
}

export function handleGoogleLogin(request: Request, env: Env): Response {
  const url = new URL(request.url);
  const redirect = url.searchParams.get('redirect') || '/';
  const config = getConfig(env);

  const state: OAuthState = {
    redirect,
    nonce: crypto.randomUUID(),
  };
  const stateStr = btoa(JSON.stringify(state));

  const authUrl = new URL(GOOGLE_AUTH_URL);
  authUrl.searchParams.set('client_id', config.client_id);
  authUrl.searchParams.set('redirect_uri', getRedirectUri(request));
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('scope', 'openid email profile');
  authUrl.searchParams.set('state', stateStr);
  authUrl.searchParams.set('access_type', 'online');
  authUrl.searchParams.set('prompt', 'select_account');

  return new Response(null, {
    status: 302,
    headers: {
      Location: authUrl.toString(),
      'Set-Cookie': createStateCookie(stateStr),
    },
  });
}

export async function handleGoogleCallback(
  request: Request,
  env: Env
): Promise<Response> {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const stateParam = url.searchParams.get('state');
  const error = url.searchParams.get('error');

  if (error) {
    return new Response(`OAuth error: ${error}`, { status: 400 });
  }

  if (!code || !stateParam) {
    return new Response('Missing code or state', { status: 400 });
  }

  // state検証
  const savedState = getStateCookie(request);
  if (savedState !== stateParam) {
    return new Response('State mismatch', { status: 400 });
  }

  let state: OAuthState;
  try {
    state = JSON.parse(atob(stateParam));
  } catch {
    return new Response('Invalid state', { status: 400 });
  }

  const config = getConfig(env);

  // トークン交換
  const tokenResponse = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: config.client_id,
      client_secret: config.client_secret,
      redirect_uri: getRedirectUri(request),
      grant_type: 'authorization_code',
    }),
  });

  if (!tokenResponse.ok) {
    const errorText = await tokenResponse.text();
    console.error('Token exchange failed:', errorText);
    return new Response('Token exchange failed', { status: 500 });
  }

  const tokenData = (await tokenResponse.json()) as { access_token: string };

  // ユーザー情報取得
  const userResponse = await fetch(GOOGLE_USERINFO_URL, {
    headers: { Authorization: `Bearer ${tokenData.access_token}` },
  });

  if (!userResponse.ok) {
    return new Response('Failed to get user info', { status: 500 });
  }

  const userInfo = (await userResponse.json()) as {
    id: string;
    email: string;
    name: string;
  };

  // メール許可リストチェック
  if (env.ALLOWED_EMAILS && !isEmailAllowed(userInfo.email, env.ALLOWED_EMAILS)) {
    return new Response('このメールアドレスは許可されていません', {
      status: 403,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  }

  // セッションCookie作成
  const sessionCookie = await createSessionCookie(
    {
      sub: userInfo.id,
      email: userInfo.email,
      name: userInfo.name,
      provider: 'google',
    },
    env
  );

  const headers = new Headers();
  headers.set('Location', state.redirect);
  headers.append('Set-Cookie', sessionCookie);
  headers.append('Set-Cookie', clearStateCookie());

  return new Response(null, { status: 302, headers });
}
