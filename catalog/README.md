# 動画ツールのカタログ / Video tools catalog

`video-tools.json` は、MV Studio の中の Claude が、動画づくりで**導入を提案してよい**スキル・プラグイン・ツールの、固定の一覧です。
Claude は、動画の作業を始めるとき、道具 `list_video_tools` でこの一覧と**このプロジェクトでの導入状況**を見ます。
載っていないものは提案しません(Web で見つけたものを、その場で入れることはしません)。追加は、このファイルへの変更として行います。

`video-tools.json` is the fixed list of skills, plugins and tools that the Claude inside MV Studio may propose to install for video work.
Claude reads it (with the install state for the current project) through the `list_video_tools` tool when a video task starts.
Anything not listed is never proposed; adding something is a change to this file.

## 安全の考え方 / How it stays safe

- **一覧にあるものだけ、書かれたコマンドだけ。** コマンドは、決まった形(`npx skills add … -a claude-code --copy -y`、`claude plugin … --scope project`、`claude mcp add … --scope project`)に限られ、`npm test` が検査します。全体への導入(`-g`、`--scope user`)、`--all`、パイプ、連結(`&&` `;`)、引用符、`$()` は拒否されます。
- **毎回、ユーザーの承認。** Claude は、名前・作者・何をするか・必要なもの・料金とサインイン・実行するコマンドを見せて、承認を得てから実行します。
- **設定のボタンでも導入できる。** 左端の ⚙ 設定 > 動画ツール に一覧が出て、「導入する」を押すと、実行するコマンドと実行場所を見せてから、アプリが実行します(ログ表示、取り消し可)。導入先は、選んだプロジェクト(おすすめ)か、すべてのプロジェクト(user 範囲。確認画面で選ぶ)です。実行できるのは、この一覧のコマンドだけです。
- **このプロジェクトの中だけ。** すべて project 範囲で、ユーザーの Claude 全体の設定は変えません(アプリの方針と同じです)。
- **サインイン・API キーはユーザーが行う。** 料金のかかる生成は、実行のたびに承認を得ます。
- **PC 全体に入れるもの(Python、ffmpeg)は、Claude は入れない。** 手順を伝えるだけです。
- 検証に通らない一覧は、アプリが読み込まず(ログに理由を出す)、Claude には何も出しません。

Commands are limited to a few exact forms checked by `npm test`: project scope only, no `-g` / `--scope user` / `--all`, no pipes, chaining, quotes or `$()`.
Claude shows what it would install (name, maker, purpose, requirements, cost, sign-in, the exact commands) and waits for a yes each time.
Sign-in and API keys are the user's; system software (Python, ffmpeg) is never installed by Claude. A catalog that fails validation is not loaded.

## 1 件の形 / An entry

```jsonc
{
  "id": "hyperframes",                  // 小文字と - だけ。重複しない
  "name": "…", "kind": "plugin",        // skills | plugin | mcp | connector | builtin | system
  "category": ["render"],               // render, music-video, animation, generation, captions, editing, audio
  "maker": "official",                  // official | community
  "status": "recommended",              // recommended | optional | installed-by-app
  "summary_ja": "…", "use_when_ja": "…",
  "source": "https://github.com/…",     // 一次情報(リポジトリ)
  "license": "…", "requires": ["…"],
  "costs": "none",                      // none | account-required | paid-accounts
  "signin": false,
  "provides": { "plugin": "name@marketplace" },   // skills は { "skills": [フォルダ名…] }、mcp は { "mcp": "サーバー名" }
  "install": { "commands": ["…"] },     // skills / plugin / mcp のとき。connector / builtin / system は manual_steps_ja
  "notes_ja": ["注意点…"],
  "verified": "2026-11-05",             // 事実を確認した日
  "evidence": ["https://…"]             // 確認した場所
}
```

`provides` は、導入状況を判定するために使います(skills は `.claude/skills/<名前>/SKILL.md`、plugin は `claude plugin list --json`、mcp は `.mcp.json`)。

## 追加するときの確認 / Before adding an entry

1. **一次情報で確認する**: リポジトリの README・LICENSE・導入手順を読み、ブログや一覧サイトの情報だけで書かない。確認日と根拠を `verified` / `evidence` に残す。
2. **中身を読む**: `SKILL.md` とスクリプトが何を実行するか(ネットワーク、`npx -y`、外部パッケージの自動取得、ファイルの書き込み)を見て、`notes_ja` に書く。
3. **ライセンスと料金**: 商用利用の条件(例: Remotion は、従業員 4 名以上の営利組織は会社ライセンスが必要)、有料アカウント、クレジットの有無を書く。
4. **導入コマンドを、決まった形で書く**: project 範囲。公式の手順が user 範囲なら、project に直す。コマンドが確認できないものは、`install` を書かず、`watchlist` に理由を書く。
5. **メンテナンスの状況**: 小さく新しい、コミットが少ない、出どころが紛らわしいなどは、`notes_ja` か `watchlist` に書く。
6. `npm test` を通す(`test/catalog.test.mjs` が、一覧の形とコマンドを検査します)。

## 調べた候補 / Where candidates come from

- 動画系スキルの一覧(リポジトリごとに第三者の安全性評価つき): <https://github.com/zhuyansen/awesome-claude-video-skills>。評価は参考で、保証ではありません。
- モーションデザイン系の一覧: <https://github.com/frankxai/awesome-motion-design-agent-skills>
- Remotion 公式: <https://github.com/remotion-dev/skills> / HyperFrames(HeyGen): <https://github.com/heygen-com/hyperframes>

`video-tools.json` の `watchlist` に、調べたが載せていないもの(理由つき)があります。確認が取れたら、`entries` に移します。
