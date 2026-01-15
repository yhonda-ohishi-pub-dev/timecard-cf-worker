// 認証関連の型定義

export interface Env {
  WEBSOCKET_HIBERNATION: DurableObjectNamespace;
  GRPC_API_URL: string;
  JWT_SECRET: string;
  GOOGLE_OAUTH_CONFIG: string; // JSON配列形式
  LINEWORKS_CONFIG: string; // JSON形式
  CF_ACCESS_TEAM_NAME: string;
  CF_ACCESS_AUD?: string;
  ALLOWED_EMAILS?: string; // カンマ区切りの許可メールリスト
  WOFF_ID?: string; // WOFF SDK用のID
}

export interface GoogleOAuthConfig {
  client_id: string;
  client_secret: string;
}

export interface LineworksConfig {
  client_id: string;
  client_secret: string;
}

export interface SessionPayload {
  sub: string;
  email: string;
  name: string;
  provider: 'google' | 'lineworks' | 'cf_access';
  iat: number;
  exp: number;
}

export interface AuthResult {
  authenticated: boolean;
  user?: SessionPayload;
}

export interface OAuthState {
  redirect: string;
  nonce: string;
}

// メール許可チェック（@で始まるエントリーはドメインフィルター）
export function isEmailAllowed(email: string, allowedEmails: string): boolean {
  const emailLower = email.toLowerCase();
  const entries = allowedEmails.split(',').map((e) => e.trim().toLowerCase());

  for (const entry of entries) {
    if (entry.startsWith('@')) {
      // ドメインフィルター
      if (emailLower.endsWith(entry)) {
        return true;
      }
    } else {
      // 完全一致
      if (emailLower === entry) {
        return true;
      }
    }
  }
  return false;
}
