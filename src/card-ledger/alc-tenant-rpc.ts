/**
 * auth-worker の RPC entrypoint (`InternalEntrypoint.forwardAlcTenantData`) 越しに
 * alc 側の tenant data 経路を叩くための型 (Refs ippoan/auth-worker#566)。
 *
 * ## なぜ RPC なのか
 *
 * 転送先 (rust-alc-api) は Cloud Run の IAM で閉じていて直叩きできない。
 * auth-worker が `X-Tenant-ID` の注入と OIDC の mint を担い、
 * **Workers RPC の名前付きメソッドは service binding からしか呼べず HTTP の面に出ない**ので、
 * 共有シークレットや device credential を**この Worker にもオンプレ側にも置かずに済む**。
 *
 * ## 黙って成功にしない
 *
 * `forwardAlcTenantData` は**失敗しても throw せず戻り値**で返す (403 が握り潰されて
 * 「0 件取り込めた」に化けるのが一番まずい、という auth-worker 側の設計)。
 * ⇒ 呼び手であるこちらが status を必ず見る責任を持つ。
 *
 * 同じ形の client が ohishi-exp/nuxt-dtako-admin の `workers/dtako-scraper-relay/
 * src/alc-tenant-rpc.ts` にもある。**repo をまたぐので共有できない**が、
 * RPC の面 (引数・戻り・binding 名) は意図的に同じに揃えてある。
 */

/** `forwardAlcTenantData` の戻り (auth-worker 側で固定)。 */
export interface AlcTenantDataResult {
  status: number;
  body: string;
  contentType: string | null;
}

/** `forwardAlcTenantData` の引数 (auth-worker 側で固定)。 */
export interface AlcTenantDataInput {
  /** 転送先に `X-Tenant-ID` として注入される tenant。**この Worker の設定から渡す。** */
  tenantId: string;
  /** rust-alc-api 側の path。auth-worker の allowlist に無ければ 403。 */
  path: string;
  method: string;
  /** `?limit=20` のような query (先頭の `?` は有っても無くても良い)。 */
  search?: string;
  body?: string;
  contentType?: string;
}

/**
 * `AUTH_WORKER_RPC` binding の面。**テストでそのまま差し替えられる**ように、
 * binding の型ではなくこの最小 interface に依存する。
 */
export interface AlcTenantDataForwarder {
  forwardAlcTenantData(input: AlcTenantDataInput): Promise<AlcTenantDataResult>;
}

/** RPC 越しの失敗。**何が起きたかを文面に含める** (呼び手が loud に鳴らせるように)。 */
export class AlcTenantRpcError extends Error {}

/**
 * binding が張られていないときの文言。**「黙って動かない」を避ける**ためだけに居る。
 */
export const ALC_TENANT_RPC_MISSING =
  'AUTH_WORKER_RPC binding がありません ' +
  '(wrangler.toml に entrypoint = "InternalEntrypoint" の [[services]] が要ります)';

/** tenant が設定されていないときの文言。**呼び出し側 (HTTP) には決めさせない。** */
export const ALC_TENANT_ID_MISSING =
  'ALC_TENANT_ID が未設定です (wrangler secret put ALC_TENANT_ID で入れてください)';

/**
 * binding を検証して返す。未設定なら [`ALC_TENANT_RPC_MISSING`] を throw する。
 * **`undefined` を黙って通さない**ための関門。
 */
export function requireAlcTenantForwarder(
  binding: AlcTenantDataForwarder | undefined | null
): AlcTenantDataForwarder {
  if (!binding) throw new AlcTenantRpcError(ALC_TENANT_RPC_MISSING);
  return binding;
}

/** tenant を検証して返す。空なら [`ALC_TENANT_ID_MISSING`] を throw する。 */
export function requireAlcTenantId(tenantId: string | undefined | null): string {
  const trimmed = (tenantId || '').trim();
  if (!trimmed) throw new AlcTenantRpcError(ALC_TENANT_ID_MISSING);
  return trimmed;
}
