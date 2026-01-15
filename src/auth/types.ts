// 認証関連の型定義

export interface Env {
  WEBSOCKET_HIBERNATION: DurableObjectNamespace;
  GRPC_API_URL: string;
  JWT_SECRET: string;
  GOOGLE_OAUTH_CONFIG: string; // JSON配列形式
  LINEWORKS_CONFIG: string; // JSON形式
  CF_ACCESS_TEAM_NAME: string;
  CF_ACCESS_AUD?: string;
}

export interface GoogleOAuthConfig {
  client_id: string;
  client_secret: string;
}

export interface LineworksConfig {
  client_id: string;
  client_secret: string;
  service_account: string;
  private_key: string;
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
