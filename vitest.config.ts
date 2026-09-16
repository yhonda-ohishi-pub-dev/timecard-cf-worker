import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // テストは test/ にだけ置く。
    // ★ 既定の include は cwd 配下を丸ごと舐めるため、開発ツールが
    //    .claude/worktrees/<名前>/ に作る repo のコピー内のテストまで拾ってしまう
    //    (実測: 実ファイル 3 本が 5 files / 77 tests に水増しされた)。
    //    古いコピーのテストが混ざると「直したはずの版」が green を出すので、
    //    include で置き場を明示して閉じる。
    include: ['test/**/*.test.ts'],
  },
});
