# MV Studio

左に **Claude Code のターミナル**、右に **歌詞づくりと曲の一覧** を並べる、ローカルで動く小さなアプリです。
歌詞・スタイル・設定を人と Claude で一緒に作り、Suno に生成を依頼し、できた曲をダウンロードする前に試聴できます。

A small local app: a real **Claude Code terminal** on the left, a **drafting space and your songs** on the right.
Write lyrics, style and settings together with Claude, send them to Suno, and listen to the results *before* spending a
monthly download credit.

> Status: early and deliberately small. Verified on Windows only. / 初期段階で、あえて小さくしています。動作確認は Windows のみです。

## 使い方 / Quick start

必要なもの / Requirements: Node.js 20+, [Claude Code](https://claude.com/claude-code) (`claude` on PATH), a Suno account.

```
git clone <this repo>
cd <this repo>
start.cmd [workspace] [port]    # Windows: installs dependencies on first run, opens the browser
# or, anywhere:
npm install
npm start -- [workspace] [port] # same launcher; default port 4200, workspace ../workspace
```

1. **PJ一覧**で「+ 新規」から MV の名前を入力 → PJ ができ、左で Claude が起動します。
2. 初回は Claude のフォルダ信頼を承認し、`/mcp` で Suno にサインインします。
3. **歌詞・スタイル・設定** タブで、左の「人の案」に曲名・スタイル・歌詞・設定を書いて保存します。
4. 右の「Claude の修正案」を見ながら進めます(下の「Claude との流れ」)。
5. できた曲は **曲ライブラリ** タブに出ます。Suno のプレーヤーでその場で聴けます。
6. 残したい曲だけ、Claude に「ダウンロードして」と頼みます(ダウンロード枠を使うので、都度確認が入ります)。

## Claude との流れ / Working with Claude

歌詞タブの 3 つのボタンは、ターミナルに **1 行の依頼を入力するだけ** です。送信(Enter)はあなたが押します。

| ボタン | Claude がすること |
|---|---|
| Claude に確認を頼む | 人の案を読み、歌詞などを完成させて右に出します。**Suno にはまだ投げません** |
| 完成させて生成まで任せる | 完成させて、その内容で Suno に生成を依頼します |
| この案で生成 | 左の案をそのまま Suno に投げます |

- 人の案と Claude の案は、**別々のファイル**です。アプリが書くのは人の案だけ、Claude が書くのは Claude の案だけなので、上書きし合いません。
- 右の案が良ければ「この案を左に取り込む」でコピーします(保存するまで、あなたの案は変わりません)。
- 歌詞には「元に戻す / やり直す」(Ctrl+Z / Ctrl+Shift+Z)があります。
- 編集中にファイルが外で更新された場合は、通知を出して保存を止めます(上書き事故の防止)。
- Suno の生成枠を使うのは、下 2 つのボタンと、あなたが明示的に頼んだときだけです。

## 仕組み / How it works

```
<workspace>/
  PJs/<YYYYMMDD-name>/        one folder per MV (Claude runs here)
    Drafts/<name>.human.json    your draft (only the app writes it)
    Drafts/<name>.claude.json   Claude's suggestion (only Claude writes it)
    Output/song/                <name>.suno.json (preview) -> <name>.mp3 (downloaded)
  _Trash/                     "deleted" projects are moved here, never erased
```

- **フォルダが API**: アプリは Suno を直接呼びません。Claude がファイルを書き、アプリが読みます。
- **ルールは起動時に渡す**: Claude の振る舞い(保存場所、ボタンの意味、生成の手順)は `rules/mv-studio.md` に書かれ、`--append-system-prompt-file` で毎回渡されます。PJ の `CLAUDE.md` はあなたのメモ用です。
- **試聴**: Claude が `<name>.suno.json`(ID、タイトル、歌詞、生成時の指定など)を保存し、アプリが Suno の埋め込みプレーヤーを表示します。同名の mp3 が入るとローカルのプレーヤーに切り替わります。
- **Suno の接続**: `claude --mcp-config suno.mcp.json` で起動時に渡します。あなたの Claude の設定は書き換えません。
- **セッション保持**: PJ ごとの Claude はタブを閉じても、PJ を切り替えても動き続けます(同時に 5 つまで)。PJ一覧の「終了」で止めます。サーバーを止めると、すべて終了します。
- **削除**: PJ一覧でチェックして「ゴミ箱へ移動」。`_Trash` へ移るだけで、完全には消えません。実行中の PJ は移せません。
- **画面**: 左のターミナルと右の境界はドラッグで動かせます(ダブルクリックで元に戻る)。
- **ツールバーと設定**: 左端の細いバーに、ツールのアイコンが並びます(いまは ⚙ 設定だけ)。バーは「‹」で畳めます(左端の取っ手で開き直し)。設定では、サーバーの状態を見て、**再起動**と**停止**ができます。どちらも、動いている Claude をすべて終了させるので、確認が出ます。再起動は `start.cmd` から起動したときだけ使えます(終了コード 75 で終了し、`start.cmd` が同じウィンドウで起動し直します)。起動は `launcher.mjs` が担当します。
  - ポートが空いていれば、サーバーを起動して画面を開きます。
  - すでに**最新の** MV Studio が動いていれば、**画面だけ**開きます。
  - **古い**コードの MV Studio が動いていれば、「再起動して最新にする / そのまま開く / 終了」を選べます(再起動すると、そこで動いている Claude が終了します)。最新かどうかは、アプリのファイルの指紋(ハッシュ)で判定します。
  - 別のワークスペースの MV Studio や、別のプログラムがポートを使っているときは、理由を表示して止まります。

## セキュリティ / Security

- `127.0.0.1` のみで待ち受けます。WebSocket とファイルを変更する API は、同一オリジンのみ受け付けます。
- ターミナルは、あなたの PC でシェルを動かします。**ポートを外部に公開しないでください。**
- ボタンがターミナルに入力する文字列は 1 行のみで、改行や制御文字は拒否されます(勝手に送信されません)。
- 音声ファイルは、PJ の `Output/` 内のものだけを配信します。

## 既知の制限 / Known limits

- Windows 以外(macOS / Linux)は未確認です。`Output`(大文字)と `output`(小文字)は、Windows では同じフォルダ扱いです。
- Suno にサインインしていないブラウザで、非公開曲の埋め込みが再生できるかは未確認です。
- 「完成させて生成まで任せる」「この案で生成」は、Suno の生成枠を使うため、開発中は通しで検証できていません。
- Claude が `Drafts/*.claude.json` や `suno.json` を、ルールどおりに書くことに依存しています(壊れていた場合は、画面にエラーを出し、ファイルには触れません)。
- 1 回の生成で何曲できるかは Suno 側の仕様です。返ってきた曲は全部カードになります。
- 自動テストはありません。

## ライセンス / License

MIT. See [LICENSE](LICENSE).
