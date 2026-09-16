// API Routes - Proxy to Rust gRPC-Web backend

import { GrpcWebClient } from '../grpc-client';
import {
  CARD_LEDGER_IMPORT_PATH,
  handleCardLedgerImport,
  type CardLedgerEnv,
} from '../card-ledger/route';
import { upsertOneCard, deleteOneCard } from '../card-ledger/sync-one';

export interface Env extends CardLedgerEnv {
  GRPC_API_URL: string;
}

export async function handleApiRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;

  const grpcClient = new GrpcWebClient(env.GRPC_API_URL);

  try {
    // Route handlers
    if (path === '/api/drivers' && request.method === 'GET') {
      const drivers = await grpcClient.getDrivers();
      return jsonResponse(drivers);
    }

    if (path === '/api/drivers/reload' && request.method === 'POST') {
      const drivers = await grpcClient.reloadDrivers();
      return jsonResponse(drivers);
    }

    if (path === '/api/driver_id' && request.method === 'GET') {
      const driverId = url.searchParams.get('driver_id');
      if (!driverId) {
        return jsonResponse({ error: 'driver_id is required' }, 400);
      }
      const driver = await grpcClient.getDriverById(parseInt(driverId));
      return jsonResponse(driver);
    }

    if (path === '/api/pic_tmp' && request.method === 'GET') {
      const limit = parseInt(url.searchParams.get('limit') || '30');
      const start = url.searchParams.get('start') || undefined;
      const data = await grpcClient.getPicTmp(limit, start);
      return jsonResponse(data);
    }

    if (path === '/api/ic_non_reg' && request.method === 'GET') {
      const items = await grpcClient.getIcNonReg();
      return jsonResponse(items);
    }

    if (path === '/api/ic_non_reg/register' && request.method === 'POST') {
      const body = await request.json() as { ic_id: string; driver_id: number };
      const result = await grpcClient.registerIc(body.ic_id, body.driver_id);
      // オンプレ成功後に alc へも転送する。code は String(driver_id) — Number() は挟まない。
      const alc = await upsertOneCard(env, { code: String(body.driver_id), cardId: body.ic_id });
      return jsonResponse({ ...result, alc });
    }

    if (path === '/api/ic_non_reg/cancel' && request.method === 'POST') {
      const body = await request.json() as { ic_id: string };
      const result = await grpcClient.cancelIcReservation(body.ic_id);
      // オンプレの取消 (中央 DB は触らない) の後、alc 側の行も消す。失敗は握り潰さない。
      const alc = await deleteOneCard(env, { cardId: body.ic_id });
      return jsonResponse({ ...result, alc });
    }

    if (path === '/api/ic_log' && request.method === 'GET') {
      const logs = await grpcClient.getIcLog();
      return jsonResponse(logs);
    }

    // Direct IC registration via Web NFC (gRPC)
    if (path === '/api/ic/register_direct' && request.method === 'POST') {
      const body = await request.json() as { ic_id: string; driver_id: number };
      const result = await grpcClient.registerDirectIc(body.ic_id, body.driver_id);
      if (!result.success) return jsonResponse(result);
      const alc = await upsertOneCard(env, { code: String(body.driver_id), cardId: body.ic_id });
      return jsonResponse({ ...result, alc });
    }

    // IC削除（Socket.IO経由でPythonクライアントに通知）
    if (path === '/api/ic/delete' && request.method === 'POST') {
      const body = await request.json() as { ic_id: string };
      const result = await grpcClient.deleteIc(body.ic_id);
      if (!result.success) return jsonResponse(result);
      // ★ delete_ic はセントラル DB を触らない (socket.io に emit するだけ)。
      //   突き合わせで拾えない削除を、ここで alc へ転送するのが唯一の手段。
      //   失敗は握り潰さない — 画面 (src/index.ts) が赤く出す。
      const alc = await deleteOneCard(env, { cardId: body.ic_id });
      return jsonResponse({ ...result, alc });
    }

    // 最新のタイムカード記録（ドライバー名付き）
    if (path === '/api/ic_log_list' && request.method === 'GET') {
      const limit = parseInt(url.searchParams.get('limit') || '100');
      const logs = await grpcClient.getLatestIcLogWithDriver(limit);
      return jsonResponse(logs);
    }

    // 接続中のSocket.IOクライアント一覧
    if (path === '/api/clients' && request.method === 'GET') {
      const clients = await grpcClient.getClients();
      return jsonResponse({ clients, total: clients.length });
    }

    // カード台帳の初回移行 (手で 1 回だけ叩く管理用の口。cron は無い)。
    // /api/ 配下なので index.ts の認証を通った後にしか来ない。
    if (path === CARD_LEDGER_IMPORT_PATH && request.method === 'POST') {
      return handleCardLedgerImport(request, env);
    }

    // APIバージョン情報
    if (path === '/api/version' && request.method === 'GET') {
      const version = await grpcClient.getVersion();
      return jsonResponse(version);
    }

    return new Response('Not found', { status: 404 });
  } catch (error) {
    console.error('API error:', error);
    return jsonResponse({
      error: error instanceof Error ? error.message : 'Internal server error'
    }, 500);
  }
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
