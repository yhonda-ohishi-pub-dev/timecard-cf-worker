# tc-ohishi Auth Header Injector

`tc-ohishi.mtamaramu.com` へのリクエストにのみ `tc_session` Cookie を注入する、個人用の最小権限 Chrome 拡張 (Manifest V3)。
Chrome Web Store から削除された ModHeader の代替として、本リポジトリで自前管理する。

`tc_session` はアプリ自前ログイン (Google / LINE WORKS / WOFF) 成功後に発行される HttpOnly Cookie で、
worker 側の検証 (`src/auth/session.ts`) は有効期限チェックを行わない実装になっているため、
一度取得した値は事実上無期限に使える。Cloudflare Access は一切関係ない。

Chrome Web Store には公開しない。`chrome://extensions` の「パッケージ化されていない拡張機能を読み込む」で使う。

## 読み込み手順

1. `chrome://extensions` を開く
2. 右上の「デベロッパーモード」を ON にする
3. 「パッケージ化されていない拡張機能を読み込む」を押し、この `tc-ohishi-auth-header/` フォルダを選択する
4. 通常の Chrome タブで `https://tc-ohishi.mtamaramu.com/` を開き、Google / LINE WORKS / WOFF のいずれかでログインする
5. ツールバーの拡張アイコンから popup を開き、「現在のログインを保存」を押す

## 使い方

- 「現在のログインを保存」: `chrome.cookies.get()` で現在の `tc_session` Cookie の値を取得し、`chrome.storage.local` に保存。同時に注入を有効化する
- 「有効にする」チェック: 保存済みの値のまま注入のon/offだけを切り替える (値の再取得はしない)
- 「動作確認」: `https://tc-ohishi.mtamaramu.com/api/auth/check` を叩き、`authenticated` の値を表示する
- ブラウザで明示的にログアウトしたり `tc_session` を手動で失効させない限り、再取得は不要
- 別アカウントで取り直す等、再ログインが必要な場合は先に「有効にする」のチェックを外してから
  `https://tc-ohishi.mtamaramu.com/` にアクセスすること (有効なままだと注入した古い Cookie が
  ログインフロー自体を妨げる)

## 権限

- `host_permissions`: `https://tc-ohishi.mtamaramu.com/*` のみ
- `declarativeNetRequestWithHostAccess` / `storage` / `cookies` のみ。他ホストへは一切作用しない。
- `cookies` 権限は `host_permissions` で許可された `tc-ohishi.mtamaramu.com` の Cookie 読み取りにのみ使う。
