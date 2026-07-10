# tc-ohishi Auth Header Injector

`tc-ohishi.mtamaramu.com` へのリクエストにのみ `CF-Access-Jwt-Assertion` ヘッダーを注入する、個人用の最小権限 Chrome 拡張 (Manifest V3)。
Chrome Web Store から削除された ModHeader の代替として、本リポジトリで自前管理する。

Chrome Web Store には公開しない。`chrome://extensions` の「パッケージ化されていない拡張機能を読み込む」で使う。

## 読み込み手順

1. `chrome://extensions` を開く
2. 右上の「デベロッパーモード」を ON にする
3. 「パッケージ化されていない拡張機能を読み込む」を押し、この `tc-ohishi-auth-header/` フォルダを選択する
4. ツールバーの拡張アイコンから popup を開き、`CF-Access-Jwt-Assertion` の値 (JWT) を貼り付けて「有効にする」にチェック → 「保存」

## 使い方

- 「保存」: JWT と有効/無効を `chrome.storage.local` に保存し、`declarativeNetRequest` の動的ルールへ即時反映する
- 「動作確認」: `https://tc-ohishi.mtamaramu.com/api/auth/check` を叩き、`authenticated` の値を表示する
- JWT の有効期限が切れたら、ログインし直して新しい値を popup に貼り直す (自動更新はしない)

## 権限

- `host_permissions`: `https://tc-ohishi.mtamaramu.com/*` のみ
- `declarativeNetRequestWithHostAccess` / `storage` のみ。他ホストへは一切作用しない。
