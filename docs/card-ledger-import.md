# IC カード台帳の初回移行 (手で 1 回だけ流す)

既存タイムカードの IC カード台帳 (`ic_id` テーブル) を、別システム (alc 側の
PostgreSQL) へ**初回移行**するための手順。

## 経路

```
timecard-rust-api  /timecard.CardLedgerService/ListCards   (grpc-web。keyset ページング)
        ↓  GRPC_API_URL (この Worker が元から使っている経路)
timecard-cf-worker (この repo。★ 鍵を持つのはここ)
        ↓  service binding  AUTH_WORKER_RPC.forwardAlcTenantData
auth-worker   X-Tenant-ID を注入 + OIDC を mint
        ↓
rust-alc-api  PUT /api/timecard/cards/bulk-by-code
```

**なぜこの形か**: 転送先は Cloud Run の IAM で閉じていて直叩きできない。また、オンプレ側の
筐体に資格情報を置くと、共有シークレットが consumer ごとに分かれていないため他の内部経路も
叩けてしまう。**Workers RPC の名前付きメソッドは service binding からしか呼べず HTTP の面に
出ない**ので、この Worker が tenant と binding を持ち、**オンプレ側には何も置かない**。

## 事前に要るもの

| 何 | どこ | 備考 |
|---|---|---|
| `AUTH_WORKER_RPC` | `wrangler.toml` の `[[services]]` | `entrypoint = "InternalEntrypoint"` |
| `ALC_TENANT_ID` | `wrangler secret put ALC_TENANT_ID` | **値は repo に書かない**。呼び出し側にも決めさせない |
| `GRPC_API_URL` | 既存の設定 | `ListCards` は上流に本番反映済み |

転送先の path は auth-worker の `FORWARDABLE_PATHS` に載っている必要がある
(`/api/timecard/cards/bulk-by-code`)。

## 流し方

口は `POST /api/admin/card-ledger/import` の 1 本だけ。**cron は無い** (1 回流せば足りるので
常設の口を増やしていない)。`/api/` 配下なので、**既存の管理者ログイン (Cloudflare Access JWT /
セッション Cookie) を通った後にしか届かない**。ブラウザでログイン済みのタブから叩くのが早い。

### 1. まず dry run (**既定**)

```js
await fetch('/api/admin/card-ledger/import', { method: 'POST' }).then((r) => r.json())
```

`dry_run` は下流へそのまま渡り、**下流は 1 行も書かずに判定だけ返す**。

### 2. 中身を確認する

```jsonc
{
  "dry_run": true,
  "fetched": 0,             // 上流から受け取った行数
  "pages": 0,               // ListCards を呼んだ回数
  "dropped_no_emp_id": 0,   // emp_id が無くてこの Worker が落とした行数
  "sent": 0,                // 下流へ送った items 数 (= fetched - dropped_no_emp_id)
  "batches": 0,             // 下流へ投げた PUT の本数 (500 件ごと)
  "created": 0, "updated": 0, "unchanged": 0,
  "skipped": [{ "batch": 1, "index": 0, "code": "...", "reason": "employee_not_found" }],
  "skipped_by_reason": { "employee_not_found": 0 }
}
```

`reason` は `employee_not_found` / `invalid_card_id` / `card_owner_conflict` /
`duplicate_in_batch` の 4 種。`employee_not_found` が多いなら、先に社員マスタ側
(`/api/employees/bulk-by-code`) の取り込みが済んでいるかを見る。

### 3. 本番へ流す (**明示的に `dry_run: false`**)

```js
await fetch('/api/admin/card-ledger/import', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ dry_run: false }),
}).then((r) => r.json())
```

**body 無し・壊れた JSON・`dry_run` の欠落はすべて dry run 扱い**にしてある。
うっかり本番書き込みになる経路を残さないため。

### 失敗したとき

502 が返り、**どこで落ちたか**が本文に入る。**黙って成功にしない。**

```jsonc
{
  "error": "bulk-by-code batch 2 (500 items) が 403 を返しました: ...",
  "failed_batch": 2,          // 何本目の PUT か (上流で落ちたときは null)
  "downstream_status": 403,
  "partial": { /* そこまでの集計。部分的に書けている可能性を隠さない */ }
}
```

- `403 path_not_forwardable` … auth-worker の allowlist にこの path が無い
- `403 forbidden` … 転送先がこの tenant を拒否した (↑ とは直し方が正反対)
- `503` … `AUTH_WORKER_RPC` binding か `ALC_TENANT_ID` が未設定

`dry_run: false` で途中まで書けた状態から再実行しても、`on_conflict: "skip"` で
**同じ社員の同じカードは `unchanged` になる**ので、頭からやり直して構わない。

## 決めごと (変えるときは上流・下流と揃える)

- **終端の判定は `next_cursor` が未設定かどうかだけ**。`entries.length` では判定しない —
  台帳の総数がちょうど `chunk_size` の倍数のとき、最後の chunk は**満杯かつ終端**になる
- **`ic_id` は一切加工せず** `card_id` に入れる (小文字化も区切りの除去も trim もしない)。
  **正規化は下流の 1 か所だけ**という規約
- **`emp_id` が未設定の行は送らない** (`code` が無いと下流が社員を解決できない)。
  ただし `dropped_no_emp_id` に必ず出す
- **`on_conflict` は `"skip"` 固定**。今回は初回移行で、付け替えは使わない
- **削除は送らない。** 上流が返すのは生存している行だけで、この経路は「取り込み」だけ。
  継続同期と削除の伝播は次の段
- `ic_id` は**ログにも応答にも出さない** (この repo は public)
