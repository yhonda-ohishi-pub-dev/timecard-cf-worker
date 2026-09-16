/**
 * カード台帳の取り込みで**踏みやすい 5 点**を固定するテスト。
 *
 * 1. ページングの終端が `next_cursor` の未設定だけで決まる
 *    (とくに「`entries` がちょうど `chunk_size` 件 + `next_cursor` 未設定」で
 *     もう 1 回呼ばないこと)
 * 2. `ic_id` が**加工されずに** `card_id` へ渡る (区切り文字と大文字を含む値で)
 * 3. `emp_id` が未設定の行が**送られない**、かつ**件数に出る**
 * 4. `dry_run` が下流へ**そのまま**渡り、集計が返る
 * 5. 下流が非 2xx のとき、**どの batch で落ちたか**が分かる
 *
 * ★ テストに実在するカードの IDm や社員番号は書かない (この repo は public)。
 */

import { describe, expect, it } from 'vitest';
import {
  CardLedgerImportError,
  IMPORT_LABEL,
  MAX_BULK_ITEMS,
  importCardLedger,
  type BulkUpsertRequest,
  type CardLedgerPage,
} from '../src/card-ledger/import';
import { readDryRun } from '../src/card-ledger/route';

/** 下流の 200 応答 (何も skip しなかった形)。 */
function ok(items: number, body?: Partial<Record<string, unknown>>) {
  return {
    status: 200,
    body: JSON.stringify({
      created: items,
      updated: 0,
      unchanged: 0,
      skipped: [],
      ...body,
    }),
  };
}

/** `listCards` の代役。渡した page を順に返し、呼ばれた cursor を記録する。 */
function stubListCards(pages: CardLedgerPage[]) {
  const cursors: Array<string | undefined> = [];
  let i = 0;
  return {
    cursors,
    calls: () => i,
    listCards: async (cursor: string | undefined) => {
      cursors.push(cursor);
      const page = pages[i];
      if (!page) throw new Error(`ListCards が想定より多く呼ばれました (${i + 1} 回目)`);
      i += 1;
      return page;
    },
  };
}

/** `putBulk` の代役。送られた body を全部ためる。 */
function stubPutBulk(responses?: Array<{ status: number; body: string }>) {
  const sent: BulkUpsertRequest[] = [];
  let i = 0;
  return {
    sent,
    putBulk: async (body: BulkUpsertRequest) => {
      sent.push(body);
      const res = responses?.[i] ?? ok(body.items.length);
      i += 1;
      return res;
    },
  };
}

function entries(n: number, opts?: { from?: number }) {
  const from = opts?.from ?? 0;
  return Array.from({ length: n }, (_, k) => ({
    icId: `CARD:${String(from + k).padStart(4, '0')}`,
    empId: from + k + 1,
  }));
}

describe('ページングの終端', () => {
  it('next_cursor が未設定なら、entries が満杯でももう 1 回呼ばない', async () => {
    const chunkSize = 3;
    // ★ 総数がちょうど chunk_size の倍数のとき、最後の chunk は満杯かつ終端になる。
    const list = stubListCards([
      { entries: entries(chunkSize), nextCursor: 'cursor-1' },
      { entries: entries(chunkSize, { from: chunkSize }) }, // 満杯 + next_cursor 未設定
    ]);
    const put = stubPutBulk();

    const summary = await importCardLedger({
      listCards: list.listCards,
      putBulk: put.putBulk,
      dryRun: true,
    });

    expect(list.calls()).toBe(2); // 3 回目は呼ばない
    expect(list.cursors).toEqual([undefined, 'cursor-1']); // 初回は cursor を入れない
    expect(summary.pages).toBe(2);
    expect(summary.fetched).toBe(chunkSize * 2);
    expect(summary.sent).toBe(chunkSize * 2);
  });

  it('entries が空でも next_cursor があれば続きを引く', async () => {
    const list = stubListCards([
      { entries: [], nextCursor: 'cursor-1' },
      { entries: entries(2), nextCursor: 'cursor-2' },
      { entries: [] },
    ]);
    const put = stubPutBulk();

    const summary = await importCardLedger({
      listCards: list.listCards,
      putBulk: put.putBulk,
      dryRun: true,
    });

    expect(list.calls()).toBe(3);
    expect(summary.fetched).toBe(2);
  });

  it('next_cursor が前進しないときは黙って回り続けず失敗する', async () => {
    const list = stubListCards([
      { entries: entries(1), nextCursor: 'same' },
      { entries: entries(1), nextCursor: 'same' },
    ]);
    const put = stubPutBulk();

    await expect(
      importCardLedger({ listCards: list.listCards, putBulk: put.putBulk, dryRun: true })
    ).rejects.toThrow(/前進しません/);
  });
});

describe('ic_id は加工しない', () => {
  it('区切り文字と大文字をそのまま card_id へ渡す', async () => {
    const raw = ['AB:CD:EF:01', 'ab-cd-ef-02', '  0A1B2C3D  ', 'ZZ99zz88'];
    const list = stubListCards([
      { entries: raw.map((icId, k) => ({ icId, empId: 100 + k })) },
    ]);
    const put = stubPutBulk();

    await importCardLedger({
      listCards: list.listCards,
      putBulk: put.putBulk,
      dryRun: true,
    });

    expect(put.sent).toHaveLength(1);
    expect(put.sent[0].items.map((i) => i.card_id)).toEqual(raw);
  });

  it('label は移行元が分かる固定文字列 1 種で、実データを含まない', async () => {
    const list = stubListCards([{ entries: entries(2) }]);
    const put = stubPutBulk();

    await importCardLedger({
      listCards: list.listCards,
      putBulk: put.putBulk,
      dryRun: true,
    });

    const labels = put.sent[0].items.map((i) => i.label);
    expect(new Set(labels)).toEqual(new Set([IMPORT_LABEL]));
  });
});

describe('emp_id が未設定の行', () => {
  it('送られず、落とした件数が集計に出る', async () => {
    const list = stubListCards([
      {
        entries: [
          { icId: 'AA:01', empId: 11 },
          { icId: 'AA:02' }, // emp_id なし
          { icId: 'AA:03', empId: 13 },
          { icId: 'AA:04', empId: undefined }, // 明示的な undefined も同じ
        ],
      },
    ]);
    const put = stubPutBulk();

    const summary = await importCardLedger({
      listCards: list.listCards,
      putBulk: put.putBulk,
      dryRun: true,
    });

    expect(summary.fetched).toBe(4);
    expect(summary.dropped_no_emp_id).toBe(2);
    expect(summary.sent).toBe(2);
    expect(put.sent[0].items.map((i) => i.card_id)).toEqual(['AA:01', 'AA:03']);
    expect(put.sent[0].items.map((i) => i.code)).toEqual(['11', '13']);
  });

  it('全部 emp_id 無しなら下流を 1 回も呼ばない', async () => {
    const list = stubListCards([{ entries: [{ icId: 'AA:01' }, { icId: 'AA:02' }] }]);
    const put = stubPutBulk();

    const summary = await importCardLedger({
      listCards: list.listCards,
      putBulk: put.putBulk,
      dryRun: true,
    });

    expect(put.sent).toHaveLength(0);
    expect(summary.batches).toBe(0);
    expect(summary.dropped_no_emp_id).toBe(2);
    expect(summary.sent).toBe(0);
  });
});

describe('dry_run と集計', () => {
  it('dry_run: true がそのまま下流へ渡り、集計が返る', async () => {
    const list = stubListCards([{ entries: entries(3) }]);
    const put = stubPutBulk([
      {
        status: 200,
        body: JSON.stringify({
          created: 1,
          updated: 1,
          unchanged: 0,
          skipped: [{ index: 2, code: '3', reason: 'employee_not_found' }],
        }),
      },
    ]);

    const summary = await importCardLedger({
      listCards: list.listCards,
      putBulk: put.putBulk,
      dryRun: true,
    });

    expect(put.sent[0].dry_run).toBe(true);
    expect(put.sent[0].on_conflict).toBe('skip');
    expect(summary).toMatchObject({
      dry_run: true,
      fetched: 3,
      sent: 3,
      batches: 1,
      created: 1,
      updated: 1,
      unchanged: 0,
      dropped_no_emp_id: 0,
    });
    expect(summary.skipped).toEqual([
      { batch: 1, index: 2, code: '3', reason: 'employee_not_found' },
    ]);
    expect(summary.skipped_by_reason).toEqual({ employee_not_found: 1 });
  });

  it('dry_run: false もそのまま渡る', async () => {
    const list = stubListCards([{ entries: entries(1) }]);
    const put = stubPutBulk();

    const summary = await importCardLedger({
      listCards: list.listCards,
      putBulk: put.putBulk,
      dryRun: false,
    });

    expect(put.sent[0].dry_run).toBe(false);
    expect(summary.dry_run).toBe(false);
  });

  it('500 件を超えたら分割して送る (page 境界とは独立)', async () => {
    const total = MAX_BULK_ITEMS + 2;
    const list = stubListCards([
      { entries: entries(MAX_BULK_ITEMS - 1), nextCursor: 'c1' },
      { entries: entries(3, { from: MAX_BULK_ITEMS - 1 }) },
    ]);
    const put = stubPutBulk();

    const summary = await importCardLedger({
      listCards: list.listCards,
      putBulk: put.putBulk,
      dryRun: true,
    });

    expect(put.sent.map((b) => b.items.length)).toEqual([MAX_BULK_ITEMS, 2]);
    expect(summary.batches).toBe(2);
    expect(summary.sent).toBe(total);
  });
});

describe('下流が失敗したとき', () => {
  it('非 2xx なら、どの batch で落ちたかと途中集計が分かる', async () => {
    const list = stubListCards([
      { entries: entries(MAX_BULK_ITEMS), nextCursor: 'c1' },
      { entries: entries(2, { from: MAX_BULK_ITEMS }) },
    ]);
    const put = stubPutBulk([
      ok(MAX_BULK_ITEMS),
      { status: 403, body: '{"error":"path_not_forwardable"}' },
    ]);

    const err = await importCardLedger({
      listCards: list.listCards,
      putBulk: put.putBulk,
      dryRun: false,
    }).catch((e) => e);

    expect(err).toBeInstanceOf(CardLedgerImportError);
    const e = err as CardLedgerImportError;
    expect(e.batch).toBe(2);
    expect(e.status).toBe(403);
    expect(e.message).toContain('batch 2');
    expect(e.message).toContain('403');
    // 1 本目までは通っている、が分かる (黙って成功にしない)
    expect(e.partial.batches).toBe(1);
    expect(e.partial.sent).toBe(MAX_BULK_ITEMS);
  });

  it('応答が JSON でないときも batch を名指しして失敗する', async () => {
    const list = stubListCards([{ entries: entries(1) }]);
    const put = stubPutBulk([{ status: 200, body: '<html>gateway</html>' }]);

    const err = (await importCardLedger({
      listCards: list.listCards,
      putBulk: put.putBulk,
      dryRun: false,
    }).catch((e) => e)) as CardLedgerImportError;

    expect(err).toBeInstanceOf(CardLedgerImportError);
    expect(err.batch).toBe(1);
    expect(err.message).toContain('JSON ではありません');
  });

  it('上流の ListCards が落ちたときは page 番号が分かる', async () => {
    const list = {
      listCards: async (cursor: string | undefined) => {
        if (cursor === undefined) return { entries: entries(1), nextCursor: 'c1' };
        throw new Error('upstream unavailable');
      },
    };
    const put = stubPutBulk();

    const err = (await importCardLedger({
      listCards: list.listCards,
      putBulk: put.putBulk,
      dryRun: true,
    }).catch((e) => e)) as CardLedgerImportError;

    expect(err).toBeInstanceOf(CardLedgerImportError);
    expect(err.message).toContain('page 2');
    expect(err.batch).toBeNull();
  });
});

describe('管理用の口の dry_run の読み方', () => {
  const post = (body?: string) =>
    new Request('https://example.invalid/api/admin/card-ledger/import', {
      method: 'POST',
      body,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
    });

  it('明示的な dry_run: false のときだけ本番書き込みになる', async () => {
    expect(await readDryRun(post(JSON.stringify({ dry_run: false })))).toBe(false);
  });

  it('body 無し・壊れた JSON・欠落はすべて dry run', async () => {
    expect(await readDryRun(post())).toBe(true);
    expect(await readDryRun(post('not json'))).toBe(true);
    expect(await readDryRun(post(JSON.stringify({})))).toBe(true);
    expect(await readDryRun(post(JSON.stringify({ dry_run: true })))).toBe(true);
    // 文字列 "false" のような紛らわしい値も dry run のまま (明示的な false ではない)
    expect(await readDryRun(post(JSON.stringify({ dry_run: 'false' })))).toBe(true);
  });
});
