/**
 * 画面から入る IC カードの登録・削除を、オンプレ (timecard-rust-api) 成功後に
 * alc (rust-alc-api) へも 1 件ずつ転送する。
 *
 * 形は相方 repo (ohishi-exp/nuxt-dtako-admin の
 * `workers/dtako-scraper-relay/src/scrape-dispatch.ts:172-190` の `fetchScrapeHistory`) と
 * 同じ「input + forwarder」型に揃えてある。
 *
 * ## env の解決はここで 1 回だけ
 *
 * `requireAlcTenantForwarder` / `requireAlcTenantId` を通し、未設定 (`AlcTenantRpcError`) は
 * ここで catch して `{ ok: false, reason: 'not_configured' }` を返す。**例外を route まで
 * 投げない** — `ALC_TENANT_ID` / `AUTH_WORKER_RPC` が無くても画面の登録・削除そのものは
 * 壊さないため。同様に、alc 側との通信そのものが例外を投げた場合 (ネットワーク断など) も
 * ここで吸収して `{ ok: false, reason: 'upstream_error' }` にする —
 * オンプレの登録・削除は既に成功しているので、その応答まで巻き込んで 500 にしない。
 *
 * ## card_id を出さない
 *
 * `card_id` はログにも `AlcSyncResult` にも入れない。
 *
 * ## `alc-tenant-rpc.ts` には触らない
 *
 * このファイルは相方 repo (`nuxt-dtako-admin` の `workers/dtako-scraper-relay/src/
 * alc-tenant-rpc.ts`) と意図的に同型 (`alc-tenant-rpc.ts:19-21` に明記) なので、
 * こちら側だけ export を増やすと差が開く。
 */

import {
  requireAlcTenantForwarder,
  requireAlcTenantId,
  AlcTenantRpcError,
  type AlcTenantDataForwarder,
} from './alc-tenant-rpc';
import { BULK_BY_CODE_PATH, type BulkUpsertRequest, type BulkUpsertResponse } from './import';
import type { CardLedgerEnv } from './route';

/** `delete-by-card` の path。auth-worker の転送 allowlist に載っている文字列と一致させる。 */
export const DELETE_BY_CARD_PATH = '/api/timecard/cards/delete-by-card';

/** `delete-by-card` の応答 (200 のとき)。範囲外・不在・形不正もすべて 200 で返る。 */
interface DeleteByCardResponse {
  deleted: 0 | 1;
  reason: 'deleted' | 'not_found' | 'out_of_scope' | 'invalid_card_id';
  code: string | null;
}

/**
 * 画面向けに返す alc 転送結果。**`card_id` は入れない。**
 *
 * `pending` は「成功したが、alc 側にまだ社員が同期されておらず未結び付きのまま
 * 作成された」ことを示す (`#c644-28` の受け入れ後、応答の `pending` を見て立てる)。
 * `#c644-28` マージ前 (応答に `pending` が無い) は今までどおり `{ ok: true }`。
 */
export type AlcSyncResult = { ok: true; pending?: true } | { ok: false; reason: string };

type AlcAccess =
  | { ok: true; forwarder: AlcTenantDataForwarder; tenantId: string }
  | { ok: false; reason: 'not_configured' };

/** `AUTH_WORKER_RPC` / `ALC_TENANT_ID` を検証する。未設定は例外にせず値で返す。 */
function resolveAlcAccess(env: CardLedgerEnv): AlcAccess {
  try {
    const forwarder = requireAlcTenantForwarder(env.AUTH_WORKER_RPC);
    const tenantId = requireAlcTenantId(env.ALC_TENANT_ID);
    return { ok: true, forwarder, tenantId };
  } catch (e) {
    if (e instanceof AlcTenantRpcError) {
      return { ok: false, reason: 'not_configured' };
    }
    throw e;
  }
}

/**
 * alc からの応答を検証してパースする非 export helper。
 * 2xx でない / JSON でない場合はここで `{ ok: false }` に落とす。
 */
function parseAlcJson<T>(res: {
  status: number;
  body: string;
}): { ok: true; data: T } | { ok: false; reason: string } {
  if (res.status < 200 || res.status >= 300) {
    return { ok: false, reason: `alc から status ${res.status} が返りました` };
  }
  try {
    return { ok: true, data: JSON.parse(res.body) as T };
  } catch {
    return { ok: false, reason: 'alc の応答が JSON ではありません' };
  }
}

/**
 * 画面の IC カード登録を alc へ転送する。
 *
 * 既存の `PUT /api/timecard/cards/bulk-by-code` を items 1 件で再利用する (新しい口は作らない)。
 * - `code` は `String(driver_id)` を**呼び手が渡す** (ここで `Number()` 等は挟まない)
 * - `card_id` は画面の生値をそのまま送る (正規化は alc 側の 1 か所に任せる)
 * - `label` は `null` (識別子は alc 側の `source` に移った)
 * - `dry_run` は常に `false` (同期は常に本番書き込み。引数として外から切り替えられない)
 */
export async function upsertOneCard(
  env: CardLedgerEnv,
  input: { code: string; cardId: string }
): Promise<AlcSyncResult> {
  const access = resolveAlcAccess(env);
  if (!access.ok) return access;

  try {
    const body: BulkUpsertRequest = {
      dry_run: false,
      on_conflict: 'skip',
      items: [{ code: input.code, card_id: input.cardId, label: null }],
    };

    const res = await access.forwarder.forwardAlcTenantData({
      tenantId: access.tenantId,
      path: BULK_BY_CODE_PATH,
      method: 'PUT',
      body: JSON.stringify(body),
      contentType: 'application/json',
    });

    const parsed = parseAlcJson<BulkUpsertResponse>(res);
    if (!parsed.ok) return parsed;

    const { data } = parsed;
    const applied = (data.created ?? 0) + (data.updated ?? 0) + (data.unchanged ?? 0);
    if (applied >= 1) return { ok: true };
    // `pending` は `#c644-28` 受け入れ後にだけ入る。無い応答 (undefined) は今までどおり
    // ここを通らず、下の skipped 判定に落ちる。
    if ((data.pending ?? 0) >= 1) return { ok: true, pending: true };

    const reason = data.skipped?.[0]?.reason;
    return { ok: false, reason: reason ?? 'unknown' };
  } catch {
    return { ok: false, reason: 'upstream_error' };
  }
}

/**
 * 画面の IC カード削除を alc へ転送する。
 *
 * `POST /api/timecard/cards/delete-by-card` を 1 件ずつ叩く (一括削除の口は作らない —
 * 1 リクエスト 1 枚が安全弁)。`reason` (`deleted` / `not_found` / `out_of_scope` /
 * `invalid_card_id`) をそのまま呼び手へ返し、画面向けの文面分けはここではしない。
 * **削除の失敗を握り潰す catch は書かない** — 例外は `resolveAlcAccess` の
 * 未設定判定と、alc との通信そのものが失敗したときの `upstream_error` 化にしか使わない。
 */
export async function deleteOneCard(
  env: CardLedgerEnv,
  input: { cardId: string }
): Promise<AlcSyncResult> {
  const access = resolveAlcAccess(env);
  if (!access.ok) return access;

  try {
    const res = await access.forwarder.forwardAlcTenantData({
      tenantId: access.tenantId,
      path: DELETE_BY_CARD_PATH,
      method: 'POST',
      body: JSON.stringify({ card_id: input.cardId }),
      contentType: 'application/json',
    });

    const parsed = parseAlcJson<DeleteByCardResponse>(res);
    if (!parsed.ok) return parsed;

    const { data } = parsed;
    if (data.reason === 'deleted') return { ok: true };
    return { ok: false, reason: data.reason };
  } catch {
    return { ok: false, reason: 'upstream_error' };
  }
}
