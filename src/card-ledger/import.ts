/**
 * IC カード台帳 (オンプレのタイムカード) を alc 側の DB へ初回移行する取り込み。
 *
 * 経路:
 *
 * ```
 * timecard-rust-api  /timecard.CardLedgerService/ListCards   (grpc-web。keyset ページング)
 *        ↓
 * この Worker (鍵を持つ側)
 *        ↓ service binding  AUTH_WORKER_RPC.forwardAlcTenantData
 * auth-worker   X-Tenant-ID を注入 + OIDC を mint
 *        ↓
 * rust-alc-api  PUT /api/timecard/cards/bulk-by-code
 * ```
 *
 * ## 決めごと (ここで勝手に変えない)
 *
 * - **終端の判定は `next_cursor` が未設定かどうかだけ**を見る。`entries.length` では
 *   判定しない — 台帳の総数がちょうど `chunk_size` の倍数のとき、最後の chunk は
 *   **満杯かつ `next_cursor` 未設定**になる (上流の unit test で固定された挙動)
 * - **`ic_id` は一切加工せず** `card_id` に入れる。小文字化も区切りの除去も trim もしない。
 *   **正規化は下流の 1 か所だけ**という規約なので、ここで触ると規約が 2 か所になる
 * - **`emp_id` が未設定の行は送らずに落とす** (`code` が無いと下流が社員を解決できない)。
 *   落とした件数は集計に出す — **黙って減らさない**
 * - **`on_conflict` は `"skip"` 固定**、**削除は送らない** (今回は初回移行のみ)
 * - `ic_id` は**ログにも集計にも出さない** (この repo は public)
 */

/** 下流が 1 リクエストで受け取れる items の上限 (rust-alc-api の `MAX_BULK_UPSERT_ITEMS`)。 */
export const MAX_BULK_ITEMS = 500;

/** 下流の path。auth-worker の転送 allowlist に載っている文字列と一致させる。 */
export const BULK_BY_CODE_PATH = '/api/timecard/cards/bulk-by-code';

/**
 * 取り込み元が分かる**固定文字列 1 種**。日付や社員番号などの実データは入れない
 * (入れると台帳の行ごとに別々の label になり、ラベルの意味が消える)。
 */
export const IMPORT_LABEL = 'timecard-ic-ledger-import';

/** `ListCards` が返す 1 行 (grpc-web client が畳んだ形)。 */
export interface CardLedgerEntry {
  /** カード ID。**DB の生値のまま**。 */
  icId: string;
  /** 社員番号。未設定のことがある。 */
  empId?: number;
}

/** `ListCards` の 1 chunk。 */
export interface CardLedgerPage {
  entries: CardLedgerEntry[];
  /** **続きがあるときだけ**入る。未設定 = 終端。 */
  nextCursor?: string;
}

/** 台帳を 1 chunk 引く関数。初回は `cursor` が `undefined`。 */
export type ListCardsPage = (cursor: string | undefined) => Promise<CardLedgerPage>;

/** `PUT /api/timecard/cards/bulk-by-code` の body。 */
export interface BulkUpsertRequest {
  dry_run: boolean;
  on_conflict: 'skip';
  items: Array<{ code: string; card_id: string; label: string | null }>;
}

/** 下流の応答 (2xx のとき)。 */
export interface BulkUpsertResponse {
  created: number;
  updated: number;
  unchanged: number;
  /**
   * 社員がまだ同期されておらず未結び付きのまま作成した件数 (`#c644-28` 受け入れ後に入る)。
   * 無い応答 (undefined) は `#c644-28` マージ前を意味し、今までどおり扱う。
   */
  pending?: number;
  skipped: Array<{ index: number; code: string; reason: string }>;
}

/** 1 batch を下流へ送る関数。**2xx 以外も戻り値で返す** (throw しない)。 */
export type PutBulkByCode = (
  body: BulkUpsertRequest
) => Promise<{ status: number; body: string }>;

/** 落ちた 1 件。`batch` は何本目の PUT か (1 始まり)。 */
export interface ImportSkipped {
  batch: number;
  index: number;
  code: string;
  reason: string;
}

/** 取り込みの集計。**この Worker が落とした分も出す。** */
export interface ImportSummary {
  dry_run: boolean;
  /** 上流から受け取った行数。 */
  fetched: number;
  /** `ListCards` を呼んだ回数。 */
  pages: number;
  /** `emp_id` が未設定でこの Worker が落とした行数。 */
  dropped_no_emp_id: number;
  /** 下流へ実際に送った items の数。 */
  sent: number;
  /** 下流へ投げた PUT の本数。 */
  batches: number;
  created: number;
  updated: number;
  unchanged: number;
  /** 社員がまだ同期されておらず未結び付きのまま作成した行数 (`#c644-28` 受け入れ前は常に 0)。 */
  pending: number;
  /** 下流が取り込めなかった行。 */
  skipped: ImportSkipped[];
  /** `skipped` を reason ごとに数えたもの。 */
  skipped_by_reason: Record<string, number>;
}

/**
 * 取り込みの失敗。**どこで落ちたかが分かる形**で throw する
 * (「黙って成功」にしないための唯一の出口)。
 */
export class CardLedgerImportError extends Error {
  /** 何本目の PUT で落ちたか (1 始まり)。下流を呼ぶ前に落ちたときは `null`。 */
  readonly batch: number | null;
  /** 下流の HTTP status。RPC 前に落ちたときは `null`。 */
  readonly status: number | null;
  /** そこまでの途中集計。**部分的に書けている可能性を隠さない。** */
  readonly partial: ImportSummary;

  constructor(
    message: string,
    opts: { batch: number | null; status: number | null; partial: ImportSummary }
  ) {
    super(message);
    this.name = 'CardLedgerImportError';
    this.batch = opts.batch;
    this.status = opts.status;
    this.partial = opts.partial;
  }
}

function emptySummary(dryRun: boolean): ImportSummary {
  return {
    dry_run: dryRun,
    fetched: 0,
    pages: 0,
    dropped_no_emp_id: 0,
    sent: 0,
    batches: 0,
    created: 0,
    updated: 0,
    unchanged: 0,
    pending: 0,
    skipped: [],
    skipped_by_reason: {},
  };
}

/**
 * 台帳を頭から全部引いて、500 件ずつ下流へ流す。
 *
 * `dryRun` はそのまま下流の `dry_run` に渡る (下流は 1 行も書かずに判定だけ返す)。
 */
export async function importCardLedger(opts: {
  listCards: ListCardsPage;
  putBulk: PutBulkByCode;
  dryRun: boolean;
}): Promise<ImportSummary> {
  const { listCards, putBulk, dryRun } = opts;
  const summary = emptySummary(dryRun);

  /** 500 件たまるまで持っておく buffer。page 境界と batch 境界は一致しない。 */
  let buffer: BulkUpsertRequest['items'] = [];

  const flush = async (): Promise<void> => {
    if (buffer.length === 0) return;
    const items = buffer;
    buffer = [];

    const batch = summary.batches + 1;
    const body: BulkUpsertRequest = { dry_run: dryRun, on_conflict: 'skip', items };

    let res: { status: number; body: string };
    try {
      res = await putBulk(body);
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      throw new CardLedgerImportError(
        `bulk-by-code batch ${batch} (${items.length} items) の送信に失敗: ${reason}`,
        { batch, status: null, partial: summary }
      );
    }

    if (res.status < 200 || res.status >= 300) {
      throw new CardLedgerImportError(
        `bulk-by-code batch ${batch} (${items.length} items) が ${res.status} を返しました: ` +
          res.body.slice(0, 300),
        { batch, status: res.status, partial: summary }
      );
    }

    let parsed: BulkUpsertResponse;
    try {
      parsed = JSON.parse(res.body) as BulkUpsertResponse;
    } catch {
      throw new CardLedgerImportError(
        `bulk-by-code batch ${batch} の応答が JSON ではありません: ${res.body.slice(0, 300)}`,
        { batch, status: res.status, partial: summary }
      );
    }

    summary.batches = batch;
    summary.sent += items.length;
    summary.created += parsed.created ?? 0;
    summary.updated += parsed.updated ?? 0;
    summary.unchanged += parsed.unchanged ?? 0;
    summary.pending += parsed.pending ?? 0;
    for (const s of parsed.skipped ?? []) {
      summary.skipped.push({ batch, index: s.index, code: s.code, reason: s.reason });
      summary.skipped_by_reason[s.reason] = (summary.skipped_by_reason[s.reason] ?? 0) + 1;
    }
  };

  let cursor: string | undefined = undefined;
  for (;;) {
    let page: CardLedgerPage;
    try {
      page = await listCards(cursor);
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      throw new CardLedgerImportError(
        `ListCards (page ${summary.pages + 1}) に失敗: ${reason}`,
        { batch: null, status: null, partial: summary }
      );
    }
    summary.pages += 1;

    for (const entry of page.entries) {
      summary.fetched += 1;
      if (entry.empId === undefined || entry.empId === null) {
        // `code` が無いと下流が社員を解決できないので送らない。**件数には出す。**
        summary.dropped_no_emp_id += 1;
        continue;
      }
      buffer.push({
        code: String(entry.empId),
        // ★ ic_id は無加工。正規化は下流の 1 か所だけ。
        card_id: entry.icId,
        label: IMPORT_LABEL,
      });
      if (buffer.length >= MAX_BULK_ITEMS) await flush();
    }

    // ★ 終端は next_cursor が未設定かどうかだけで決める。
    //    entries.length で判定しない (満杯かつ終端があり得る)。
    if (page.nextCursor === undefined || page.nextCursor === null) break;

    if (page.nextCursor === cursor) {
      // 上流は必ず前進するはずなので、進まない cursor は無限ループの合図。
      // **黙って回り続けない。**
      throw new CardLedgerImportError(
        `ListCards の next_cursor が前進しませんでした (page ${summary.pages})`,
        { batch: null, status: null, partial: summary }
      );
    }
    cursor = page.nextCursor;
  }

  await flush();
  return summary;
}
