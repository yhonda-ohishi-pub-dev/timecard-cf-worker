/**
 * カード台帳の取り込みを**手で 1 回だけ叩く**ための管理用の口。
 *
 * - **cron は置かない。** 今回は初回移行で 1 回流せれば足りる。常設の口を増やさない
 * - **無認証の口を新しく作らない。** `/api/` 配下なので `src/index.ts` の
 *   `authMiddleware` (Cloudflare Access JWT / セッション Cookie) を通った後にしか来ない
 * - **tenant は呼び出し側に決めさせない。** この Worker の secret (`ALC_TENANT_ID`) を使う
 * - **既定は dry run。** 実際に書くには body で明示的に `{"dry_run": false}` を送る
 */

import { GrpcWebClient } from '../grpc-client';
import {
  requireAlcTenantForwarder,
  requireAlcTenantId,
  type AlcTenantDataForwarder,
} from './alc-tenant-rpc';
import {
  BULK_BY_CODE_PATH,
  CardLedgerImportError,
  importCardLedger,
  type BulkUpsertRequest,
} from './import';

export interface CardLedgerEnv {
  GRPC_API_URL: string;
  /** auth-worker の `InternalEntrypoint` への service binding (wrangler.toml)。 */
  AUTH_WORKER_RPC?: AlcTenantDataForwarder;
  /** 転送先へ `X-Tenant-ID` として渡る tenant。**secret。コードに書かない。** */
  ALC_TENANT_ID?: string;
}

/** 手で叩く口の path。 */
export const CARD_LEDGER_IMPORT_PATH = '/api/admin/card-ledger/import';

/**
 * body の `dry_run` を読む。**明示的に `false` のときだけ**本番書き込みになる
 * (body 無し・壊れた JSON・欠落はすべて dry run)。
 */
export async function readDryRun(request: Request): Promise<boolean> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return true;
  }
  if (typeof body !== 'object' || body === null) return true;
  return (body as { dry_run?: unknown }).dry_run !== false;
}

export async function handleCardLedgerImport(
  request: Request,
  env: CardLedgerEnv
): Promise<Response> {
  const dryRun = await readDryRun(request);

  let forwarder: AlcTenantDataForwarder;
  let tenantId: string;
  try {
    forwarder = requireAlcTenantForwarder(env.AUTH_WORKER_RPC);
    tenantId = requireAlcTenantId(env.ALC_TENANT_ID);
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 503);
  }

  const grpc = new GrpcWebClient(env.GRPC_API_URL);

  try {
    const summary = await importCardLedger({
      dryRun,
      listCards: (cursor) => grpc.listCards(cursor),
      putBulk: async (body: BulkUpsertRequest) => {
        const res = await forwarder.forwardAlcTenantData({
          tenantId,
          path: BULK_BY_CODE_PATH,
          method: 'PUT',
          body: JSON.stringify(body),
          contentType: 'application/json',
        });
        return { status: res.status, body: res.body };
      },
    });
    return json(summary);
  } catch (e) {
    if (e instanceof CardLedgerImportError) {
      // ★ どの batch で落ちたかと、そこまでの途中集計を必ず返す。
      //    「黙って成功」にしない。
      return json(
        {
          error: e.message,
          failed_batch: e.batch,
          downstream_status: e.status,
          partial: e.partial,
        },
        502
      );
    }
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
