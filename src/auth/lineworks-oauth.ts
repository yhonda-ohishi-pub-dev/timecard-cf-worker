// LINE WORKS OAuth 2.0

import { type Env, type LineworksConfig, type OAuthState, isEmailAllowed } from './types';
import { createSessionCookie, createStateCookie, getStateCookie, clearStateCookie } from './session';

const LINEWORKS_AUTH_URL = 'https://auth.worksmobile.com/oauth2/v2.0/authorize';
const LINEWORKS_TOKEN_URL = 'https://auth.worksmobile.com/oauth2/v2.0/token';
const LINEWORKS_USERINFO_URL = 'https://www.worksapis.com/v1.0/users/me';

function getConfig(env: Env): LineworksConfig {
  return JSON.parse(env.LINEWORKS_CONFIG) as LineworksConfig;
}

function getRedirectUri(request: Request): string {
  const url = new URL(request.url);
  return `${url.origin}/auth/lineworks/callback`;
}

export function handleLineworksLogin(request: Request, env: Env): Response {
  const url = new URL(request.url);
  const redirect = url.searchParams.get('redirect') || '/';
  const config = getConfig(env);

  const state: OAuthState = {
    redirect,
    nonce: crypto.randomUUID(),
  };
  const stateStr = btoa(JSON.stringify(state));

  const authUrl = new URL(LINEWORKS_AUTH_URL);
  authUrl.searchParams.set('client_id', config.client_id);
  authUrl.searchParams.set('redirect_uri', getRedirectUri(request));
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('scope', 'user.read');
  authUrl.searchParams.set('state', stateStr);

  return new Response(null, {
    status: 302,
    headers: {
      Location: authUrl.toString(),
      'Set-Cookie': createStateCookie(stateStr),
    },
  });
}

export async function handleLineworksCallback(
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
  const tokenResponse = await fetch(LINEWORKS_TOKEN_URL, {
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
    console.error('LINE WORKS token exchange failed:', errorText);
    return new Response('Token exchange failed', { status: 500 });
  }

  const tokenData = (await tokenResponse.json()) as { access_token: string };

  // ユーザー情報取得
  const userResponse = await fetch(LINEWORKS_USERINFO_URL, {
    headers: { Authorization: `Bearer ${tokenData.access_token}` },
  });

  if (!userResponse.ok) {
    const errorText = await userResponse.text();
    console.error('LINE WORKS userinfo failed:', errorText);
    return new Response('Failed to get user info', { status: 500 });
  }

  const userInfo = (await userResponse.json()) as {
    userId: string;
    email?: string;
    userName?: { lastName?: string; firstName?: string };
  };

  const email = userInfo.email || `${userInfo.userId}@lineworks`;
  const name = userInfo.userName
    ? `${userInfo.userName.lastName || ''} ${userInfo.userName.firstName || ''}`.trim()
    : userInfo.userId;

  console.log('LINE WORKS userInfo:', JSON.stringify(userInfo));
  console.log('LINE WORKS email:', email);

  // メール許可リストチェック
  if (env.ALLOWED_EMAILS && !isEmailAllowed(email, env.ALLOWED_EMAILS)) {
    return new Response('このメールアドレスは許可されていません', {
      status: 403,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  }

  // セッションCookie作成
  const sessionCookie = await createSessionCookie(
    {
      sub: userInfo.userId,
      email,
      name,
      provider: 'lineworks',
    },
    env
  );

  const headers = new Headers();
  headers.set('Location', state.redirect);
  headers.append('Set-Cookie', sessionCookie);
  headers.append('Set-Cookie', clearStateCookie());

  return new Response(null, { status: 302, headers });
}
