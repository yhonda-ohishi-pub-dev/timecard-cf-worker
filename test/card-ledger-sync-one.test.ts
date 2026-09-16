/**
 * 画面から入る IC カードの登録・削除を alc へ転送する `sync-one.ts` の、
 * **踏みやすい点**を固定するテスト。
 *
 * 1. upsert が items 1 件 / `label: null` / `code` を呼び手が渡した文字列のまま送る
 *    (`Number()` / `parseInt` を挟まない — 前ゼロを壊さない)
 * 2. delete が `reason` の 4 種 (`deleted` / `not_found` / `out_of_scope` / `invalid_card_id`)
 *    を画面向けに落とし分ける
 * 3. `AUTH_WORKER_RPC` / `ALC_TENANT_ID` が未設定でも例外を投げず `not_configured` を返す
 * 4. `card_id` が `AlcSyncResult` にも `forwardAlcTenantData` 呼び出し以外の場所にも出ない
 * 5. 同期の経路に dry run の切り替えが無い (常に false、引数化していない)
 *
 * ★ テストに実在するカードの IDm や社員番号は書かない (この repo は public)。
 */

import { describe, expect, it, vi } from 'vitest';
import { DELETE_BY_CARD_PATH, deleteOneCard, upsertOneCard } from '../src/card-ledger/sync-one';
import { BULK_BY_CODE_PATH, type BulkUpsertRequest } from '../src/card-ledger/import';
import type { AlcTenantDataForwarder, AlcTenantDataInput } from '../src/card-ledger/alc-tenant-rpc';
import type { CardLedgerEnv } from '../src/card-ledger/route';

/** 呼ばれた input を記録し、指定した応答を返す forwarder の代役。 */
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

function envWith(forwarder: AlcTenantDataForwarder): CardLedgerEnv {
  return {
    GRPC_API_URL: 'http://example.invalid',
    AUTH_WORKER_RPC: forwarder,
    ALC_TENANT_ID: 'tenant-1',
  };
}

const NOT_CONFIGURED_ENVS: Array<[string, CardLedgerEnv]> = [
  ['AUTH_WORKER_RPC が無い', { GRPC_API_URL: 'http://example.invalid', ALC_TENANT_ID: 'tenant-1' }],
  [
    'ALC_TENANT_ID が無い',
    { GRPC_API_URL: 'http://example.invalid', AUTH_WORKER_RPC: stubForwarder(() => ({ status: 200, body: '{}' })).forwarder },
  ],
  [
    'ALC_TENANT_ID が空文字',
    {
      GRPC_API_URL: 'http://example.invalid',
      AUTH_WORKER_RPC: stubForwarder(() => ({ status: 200, body: '{}' })).forwarder,
      ALC_TENANT_ID: '   ',
    },
  ],
];

describe('upsertOneCard', () => {
  it('items 1 件 / label: null / code をそのまま送る (bulk-by-code を再利用)', async () => {
    const { forwarder, calls } = stubForwarder(() => ({
      status: 200,
      body: JSON.stringify({ created: 1, updated: 0, unchanged: 0, skipped: [] }),
    }));

    // ★ 前ゼロを含む driver_id が来ても、呼び手が渡した文字列のままであること
    //   (Number('0042') は 42 になり前ゼロが消える — sync-one.ts はここを一切加工しない)。
    const result = await upsertOneCard(envWith(forwarder), { code: '0042', cardId: 'AA:BB:CC:DD' });

    expect(result).toEqual({ ok: true });
    expect(calls).toHaveLength(1);
    expect(calls[0].path).toBe(BULK_BY_CODE_PATH);
    expect(calls[0].method).toBe('PUT');
    const sent = JSON.parse(calls[0].body ?? '{}') as BulkUpsertRequest;
    expect(sent.items).toEqual([{ code: '0042', card_id: 'AA:BB:CC:DD', label: null }]);
    expect(sent.dry_run).toBe(false);
    expect(sent.on_conflict).toBe('skip');
  });

  it('card_id を加工しない (大文字・コロン付きでもそのまま送る)', async () => {
    const { forwarder, calls } = stubForwarder(() => ({
      status: 200,
      body: JSON.stringify({ created: 1, updated: 0, unchanged: 0, skipped: [] }),
    }));

    await upsertOneCard(envWith(forwarder), { code: '7', cardId: 'ab:cd:EF:01' });

    const sent = JSON.parse(calls[0].body ?? '{}') as BulkUpsertRequest;
    expect(sent.items[0].card_id).toBe('ab:cd:EF:01');
  });

  it('alc が skip したら、その reason を画面向けに返す (黙って隠さない)', async () => {
    const { forwarder } = stubForwarder(() => ({
      status: 200,
      body: JSON.stringify({
        created: 0,
        updated: 0,
        unchanged: 0,
        skipped: [{ index: 0, code: '999', reason: 'employee_not_found' }],
      }),
    }));

    const result = await upsertOneCard(envWith(forwarder), { code: '999', cardId: 'CARD1' });
    expect(result).toEqual({ ok: false, reason: 'employee_not_found' });
  });

  it('alc が非 2xx を返しても例外を投げず ok:false で返す', async () => {
    const { forwarder } = stubForwarder(() => ({ status: 500, body: 'boom' }));
    const result = await upsertOneCard(envWith(forwarder), { code: '1', cardId: 'CARD1' });
    expect(result.ok).toBe(false);
  });

  it('alc の応答が JSON でなくても例外を投げず ok:false で返す', async () => {
    const { forwarder } = stubForwarder(() => ({ status: 200, body: 'not json' }));
    const result = await upsertOneCard(envWith(forwarder), { code: '1', cardId: 'CARD1' });
    expect(result.ok).toBe(false);
  });

  it.each(NOT_CONFIGURED_ENVS)('%s → 例外を投げず not_configured を返す', async (_label, env) => {
    const result = await upsertOneCard(env, { code: '1', cardId: 'CARD1' });
    expect(result).toEqual({ ok: false, reason: 'not_configured' });
  });

  it('forwarder が例外を投げても、握り潰して ok:false で返す (呼び手の応答を壊さない)', async () => {
    const forwarder: AlcTenantDataForwarder = {
      forwardAlcTenantData: vi.fn().mockRejectedValue(new Error('network down')),
    };
    const result = await upsertOneCard(envWith(forwarder), { code: '1', cardId: 'CARD1' });
    expect(result.ok).toBe(false);
  });
});

describe('deleteOneCard', () => {
  it.each([
    ['deleted', true],
    ['not_found', false],
    ['out_of_scope', false],
    ['invalid_card_id', false],
  ] as const)('reason=%s → ok=%s に落とし分ける', async (reason, ok) => {
    const { forwarder, calls } = stubForwarder(() => ({
      status: 200,
      body: JSON.stringify({ deleted: reason === 'deleted' ? 1 : 0, reason, code: null }),
    }));

    const result = await deleteOneCard(envWith(forwarder), { cardId: 'CARD1' });

    expect(calls[0].path).toBe(DELETE_BY_CARD_PATH);
    expect(calls[0].method).toBe('POST');
    if (ok) {
      expect(result).toEqual({ ok: true });
    } else {
      expect(result).toEqual({ ok: false, reason });
    }
  });

  it('dry_run を body に送らない (delete-by-card は dry_run を持たない契約)', async () => {
    const { forwarder, calls } = stubForwarder(() => ({
      status: 200,
      body: JSON.stringify({ deleted: 1, reason: 'deleted', code: null }),
    }));

    await deleteOneCard(envWith(forwarder), { cardId: 'CARD1' });

    const sent = JSON.parse(calls[0].body ?? '{}') as Record<string, unknown>;
    expect(sent).toEqual({ card_id: 'CARD1' });
    expect(sent).not.toHaveProperty('dry_run');
  });

  it.each(NOT_CONFIGURED_ENVS)('%s → 例外を投げず not_configured を返す', async (_label, env) => {
    const result = await deleteOneCard(env, { cardId: 'CARD1' });
    expect(result).toEqual({ ok: false, reason: 'not_configured' });
  });

  it('forwarder が例外を投げても、握り潰して ok:false で返す (削除失敗を画面に返せるようにする)', async () => {
    const forwarder: AlcTenantDataForwarder = {
      forwardAlcTenantData: vi.fn().mockRejectedValue(new Error('network down')),
    };
    const result = await deleteOneCard(envWith(forwarder), { cardId: 'CARD1' });
    expect(result.ok).toBe(false);
  });

  it('card_id が結果オブジェクトに出ない', async () => {
    const { forwarder } = stubForwarder(() => ({
      status: 200,
      body: JSON.stringify({ deleted: 0, reason: 'not_found', code: null }),
    }));
    const result = await deleteOneCard(envWith(forwarder), { cardId: 'super-secret-card-id' });
    expect(JSON.stringify(result)).not.toContain('super-secret-card-id');
  });
});
