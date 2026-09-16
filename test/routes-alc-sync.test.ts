/**
 * `src/api/routes.ts` の 4 フック (register / register_direct / cancel / delete) が
 * オンプレ成功後に alc へ転送すること、既存の応答フィールドを壊さないことを固定するテスト。
 *
 * `GrpcWebClient` は実際に gRPC-Web で通信するため、ここでは `vi.mock` で丸ごと差し替えて
 * オンプレ側の応答を制御する (この repo に wrangler dev / 実サーバは無い前提)。
 *
 * 1. オンプレ成功後にだけ alc へ転送する (失敗時は alc を呼ばない = 既存フィールドのみ)
 * 2. `code` はフォーム入力の文字列をそのまま `String()` した値 (前ゼロを壊さない)
 * 3. `ALC_TENANT_ID` / `AUTH_WORKER_RPC` が未設定でも、登録・削除の応答自体は壊れない
 * 4. `alc` の応答に `card_id` / `cardId` が出ない
 *
 * ★ テストに実在するカードの IDm や社員番号は書かない (この repo は public)。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AlcTenantDataForwarder, AlcTenantDataInput } from '../src/card-ledger/alc-tenant-rpc';
import type { Env } from '../src/api/routes';

vi.mock('../src/grpc-client', () => {
  const registerIc = vi.fn();
  const cancelIcReservation = vi.fn();
  const registerDirectIc = vi.fn();
  const deleteIc = vi.fn();
  return {
    __mocks: { registerIc, cancelIcReservation, registerDirectIc, deleteIc },
    // ★ arrow function は `new` できない (constructor にならない) ので、通常の function にする。
    GrpcWebClient: vi.fn().mockImplementation(function () {
      return { registerIc, cancelIcReservation, registerDirectIc, deleteIc };
    }),
  };
});

const { handleApiRequest } = await import('../src/api/routes');
const grpcModule = (await import('../src/grpc-client')) as unknown as {
  __mocks: {
    registerIc: ReturnType<typeof vi.fn>;
    cancelIcReservation: ReturnType<typeof vi.fn>;
    registerDirectIc: ReturnType<typeof vi.fn>;
    deleteIc: ReturnType<typeof vi.fn>;
  };
};
const mocks = grpcModule.__mocks;

function stubForwarder(respond: (input: AlcTenantDataInput) => { status: number; body: string }) {
  const calls: AlcTenantDataInput[] = [];
  const forwarder: AlcTenantDataForwarder = {
    forwardAlcTenantData: async (input) => {
      calls.push(input);
      const res = respond(input);
      return { status: res.status, body: res.body, contentType: 'application/json' };
    },
  };
  return { forwarder, calls };
}

function configuredEnv(forwarder: AlcTenantDataForwarder): Env {
  return { GRPC_API_URL: 'http://example.invalid', AUTH_WORKER_RPC: forwarder, ALC_TENANT_ID: 'tenant-1' };
}

function unconfiguredEnv(): Env {
  return { GRPC_API_URL: 'http://example.invalid' };
}

function post(path: string, body: unknown): Request {
  return new Request(`http://worker.local${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  mocks.registerIc.mockReset();
  mocks.cancelIcReservation.mockReset();
  mocks.registerDirectIc.mockReset();
  mocks.deleteIc.mockReset();
});

describe('/api/ic_non_reg/register', () => {
  it('オンプレ成功後、code = String(driver_id) (前ゼロ付きの文字列でも壊さない) で alc へ送る', async () => {
    mocks.registerIc.mockResolvedValue({ success: true, ic_id: 'CARD1', driver_id: '0042' });
    const upsertOk = stubForwarder(() => ({
      status: 200,
      body: JSON.stringify({ created: 1, updated: 0, unchanged: 0, skipped: [] }),
    }));

    // ★ 型は `driver_id: number` のキャストだが、実際にはフォーム入力の文字列がそのまま届く。
    const res = await handleApiRequest(
      post('/api/ic_non_reg/register', { ic_id: 'CARD1', driver_id: '0042' }),
      configuredEnv(upsertOk.forwarder)
    );
    const json = (await res.json()) as { success: boolean; alc: { ok: boolean } };

    expect(json.success).toBe(true); // 既存フィールドは壊れない
    expect(json.alc).toEqual({ ok: true });
    expect(upsertOk.calls).toHaveLength(1);
    const sentBody = JSON.parse(upsertOk.calls[0].body ?? '{}');
    expect(sentBody.items).toEqual([{ code: '0042', card_id: 'CARD1', label: null }]);
  });

  it('ALC_TENANT_ID / AUTH_WORKER_RPC が未設定でも、登録の応答自体は壊れない', async () => {
    mocks.registerIc.mockResolvedValue({ success: true, ic_id: 'CARD1', driver_id: 7 });

    const res = await handleApiRequest(
      post('/api/ic_non_reg/register', { ic_id: 'CARD1', driver_id: 7 }),
      unconfiguredEnv()
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { success: boolean; ic_id: string; alc: { ok: boolean; reason: string } };
    expect(json.success).toBe(true);
    expect(json.ic_id).toBe('CARD1');
    expect(json.alc).toEqual({ ok: false, reason: 'not_configured' });
  });
});

describe('/api/ic/register_direct', () => {
  it('オンプレが失敗 (success:false) なら alc を呼ばず、既存フィールドのみ返す', async () => {
    mocks.registerDirectIc.mockResolvedValue({
      success: false,
      message: '既に登録されています',
      ic_id: 'CARD1',
      driver_id: 7,
      driver_name: undefined,
    });
    const upsert = stubForwarder(() => ({ status: 200, body: '{}' }));

    const res = await handleApiRequest(
      post('/api/ic/register_direct', { ic_id: 'CARD1', driver_id: 7 }),
      configuredEnv(upsert.forwarder)
    );
    const json = (await res.json()) as Record<string, unknown>;

    expect(json.success).toBe(false);
    expect(json.alc).toBeUndefined();
    expect(upsert.calls).toHaveLength(0); // 失敗した onprem 呼び出しの後で alc を叩かない
  });

  it('オンプレ成功後に alc へ upsert する', async () => {
    mocks.registerDirectIc.mockResolvedValue({
      success: true,
      message: 'ok',
      ic_id: 'CARD1',
      driver_id: 7,
      driver_name: '山田',
    });
    const upsert = stubForwarder(() => ({
      status: 200,
      body: JSON.stringify({ created: 1, updated: 0, unchanged: 0, skipped: [] }),
    }));

    const res = await handleApiRequest(
      post('/api/ic/register_direct', { ic_id: 'CARD1', driver_id: 7 }),
      configuredEnv(upsert.forwarder)
    );
    const json = (await res.json()) as { alc: { ok: boolean } };
    expect(json.alc).toEqual({ ok: true });
  });
});

describe('/api/ic_non_reg/cancel', () => {
  it('オンプレ取消の後、alc の delete-by-card を叩き、reason を隠さず返す', async () => {
    mocks.cancelIcReservation.mockResolvedValue({ success: true, ic_id: 'CARD1' });
    const del = stubForwarder(() => ({
      status: 200,
      body: JSON.stringify({ deleted: 0, reason: 'out_of_scope', code: null }),
    }));

    const res = await handleApiRequest(post('/api/ic_non_reg/cancel', { ic_id: 'CARD1' }), configuredEnv(del.forwarder));
    const json = (await res.json()) as { success: boolean; alc: { ok: boolean; reason: string } };

    expect(json.success).toBe(true);
    expect(json.alc).toEqual({ ok: false, reason: 'out_of_scope' });
    expect(del.calls[0].method).toBe('POST');
    const sent = JSON.parse(del.calls[0].body ?? '{}');
    expect(sent).toEqual({ card_id: 'CARD1' }); // dry_run を送らない
  });

  it('ALC_TENANT_ID / AUTH_WORKER_RPC が未設定でも、取消の応答自体は壊れない', async () => {
    mocks.cancelIcReservation.mockResolvedValue({ success: true, ic_id: 'CARD1' });

    const res = await handleApiRequest(post('/api/ic_non_reg/cancel', { ic_id: 'CARD1' }), unconfiguredEnv());
    expect(res.status).toBe(200);
    const json = (await res.json()) as { success: boolean; alc: { ok: boolean; reason: string } };
    expect(json.success).toBe(true);
    expect(json.alc).toEqual({ ok: false, reason: 'not_configured' });
  });
});

describe('/api/ic/delete', () => {
  it('オンプレが失敗 (success:false) なら alc を呼ばない (中央 DB は元々触らないが、失敗時は転送もしない)', async () => {
    mocks.deleteIc.mockResolvedValue({ success: false, message: '見つかりません' });
    const del = stubForwarder(() => ({ status: 200, body: '{}' }));

    const res = await handleApiRequest(post('/api/ic/delete', { ic_id: 'CARD1' }), configuredEnv(del.forwarder));
    const json = (await res.json()) as Record<string, unknown>;

    expect(json.success).toBe(false);
    expect(json.alc).toBeUndefined();
    expect(del.calls).toHaveLength(0);
  });

  it.each([
    ['deleted', true],
    ['not_found', false],
    ['out_of_scope', false],
    ['invalid_card_id', false],
  ] as const)('オンプレ成功後、alc の reason=%s を画面向けに落とし分ける', async (reason, ok) => {
    mocks.deleteIc.mockResolvedValue({ success: true, message: 'ok' });
    const del = stubForwarder(() => ({
      status: 200,
      body: JSON.stringify({ deleted: reason === 'deleted' ? 1 : 0, reason, code: null }),
    }));

    const res = await handleApiRequest(post('/api/ic/delete', { ic_id: 'CARD1' }), configuredEnv(del.forwarder));
    const json = (await res.json()) as { success: boolean; alc: { ok: boolean; reason?: string } };

    expect(json.success).toBe(true); // ★ 削除の失敗を握り潰さない: onprem 成功と alc 失敗を両方見せる
    expect(json.alc.ok).toBe(ok);
    if (!ok) expect(json.alc.reason).toBe(reason);
  });

  it('ALC_TENANT_ID / AUTH_WORKER_RPC が未設定でも、削除の応答自体は壊れない', async () => {
    mocks.deleteIc.mockResolvedValue({ success: true, message: 'ok' });

    const res = await handleApiRequest(post('/api/ic/delete', { ic_id: 'CARD1' }), unconfiguredEnv());
    expect(res.status).toBe(200);
    const json = (await res.json()) as { success: boolean; alc: { ok: boolean; reason: string } };
    expect(json.success).toBe(true);
    expect(json.alc).toEqual({ ok: false, reason: 'not_configured' });
  });

  it('応答に card_id / cardId が出ない', async () => {
    mocks.deleteIc.mockResolvedValue({ success: true, message: 'ok' });
    const del = stubForwarder(() => ({
      status: 200,
      body: JSON.stringify({ deleted: 1, reason: 'deleted', code: null }),
    }));

    const res = await handleApiRequest(
      post('/api/ic/delete', { ic_id: 'super-secret-card-id' }),
      configuredEnv(del.forwarder)
    );
    const json = (await res.json()) as { alc: Record<string, unknown> };
    expect(json.alc).not.toHaveProperty('card_id');
    expect(json.alc).not.toHaveProperty('cardId');
    expect(JSON.stringify(json.alc)).not.toContain('super-secret-card-id');
  });
});
