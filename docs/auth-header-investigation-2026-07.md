# tc-ohishi 認証ヘッダー調査記録 (2026-07-11)

Refs #1

## 背景

`tc-ohishi.mtamaramu.com` へのアクセスで、Chrome拡張 ModHeader を使ってヘッダーを注入し
自動ログインしていたが、ModHeader が Chrome Web Store から削除され使用不能になった。
自前の Chrome 拡張 (`chrome-extension/tc-ohishi-auth-header/`) で代替する過程で、
「ModHeader は実際に何を送っていたのか」の調査に時間を使ったため、経緯を記録する。

## 調査したが不採用になった仮説: Cloudflare Access

最初に着目したのは、worker のコードに実在する CF Access JWT 検証パス
(`src/auth/cf-access.ts` の `verifyCfAccessJwt`)。ログインページの文言
「Cloudflare Access経由でアクセスすると自動ログインされます」もこれを裏付けるように見えた。

調べて分かったこと:

- `tc-ohishi.mtamaramu.com` 全体を保護する Cloudflare Access Application は**現在存在しない**。
  存在するのは `/api/broadcast` パス限定の bypass App のみ (Cloudflare API で確認)。
- 同アカウントに `ohishi-timecardpc` という無期限 (duration: forever) の Service Token が
  現存するが、対応する reusable policy (`tc-bypas`) はどの Application にもアタッチされて
  おらず (app_count: 0)、かつ decision が `bypass` (JWTを発行しない仕様) だったため、
  仮にアタッチしても機能しない設定だった。
- ライブ実地テストで確認: `CF-Access-Jwt-Assertion` ヘッダーに壊れた値を入れてリクエストしても
  Cloudflare側の介入は一切なく、worker まで素通りしていた。一方、同チーム配下の別 Access アプリ
  (`ci-dashboard.ippoan.org`) にログインして得た本物の JWT を同ヘッダーに設定したところ
  `authenticated: true` になった。**ただしこのJWTは発行から24時間で失効**しており、
  「何ヶ月もノーメンテで動いていた」という記憶と矛盾した。
- Cloudflare公式ドキュメント・Web検索でも、Service Tokenを機能させるには対象ホストの
  Access Application + Service Auth ポリシーが必須という結論で、抜け道は見当たらなかった。

この時点で Cloudflare Access 側の設定変更 (Service Auth ポリシー作成等) を進めかけたが、
「ヘッダーだけで完結していたはず」という指摘を受けて再調査した。

## 実際に判明した仕組み: `tc_session` Cookie の無期限化

`src/auth/session.ts` を読み直したところ、以下が判明した:

```ts
// session.ts:41-46 (verifySessionCookie)
const { payload } = await jose.jwtVerify(token, secret, {
  currentDate: new Date(0), // 1970年に設定して期限切れを回避
});
```

アプリ自前ログイン (Google / LINE WORKS / WOFF) 成功後に発行される `tc_session` Cookie は、
署名検証のみで**有効期限チェックを実質的に無効化**している。つまり一度ログインしてこの
Cookie の値を取得すれば、事実上無期限に使い続けられる。Cloudflare Access は一切関係ない。

ModHeader は単純に、一度ログインして手に入れた `tc_session` の値を「Cookie request header」
として固定設定していた (ModHeader は個別 Cookie の設定に対応している) と考えるのが最も
自然で、確認できた全ての事実と矛盾しない。

## 結論・対応

- Cloudflare Access 側の設定変更は不要 (PR #3 で対応方針を転換)。
- `chrome-extension/tc-ohishi-auth-header/` を `CF-Access-Jwt-Assertion` ヘッダー注入方式から
  `Cookie: tc_session=<値>` 注入方式に作り直した。popup は「現在のログインを保存」ボタン1つで
  `chrome.cookies.get()` から自動取得する形にし、手動コピペを無くした。

## 未解決・要フォロー

- 実機での「ログアウト後の挙動」の切り分けが未完了 (ログアウトで実ブラウザ側の Cookie は
  クリアされるが、拡張が保持する値自体は別ストレージなので影響を受けないはずだが未検証)。
- 対象PCで tc-ohishi.mtamaramu.com を**インストール済みPWA (スタンドアロンウィンドウ)** として
  開いている場合、Chrome拡張機能 (`declarativeNetRequest`) がそのウィンドウのリクエストに対して
  同様に効くかは Web 調査だけでは確証が得られなかった (Firefox for Android では uBlock Origin が
  PWAウィンドウで効かない事例が報告されているが、Chrome Desktop での挙動は未確認)。実機確認が必要。
