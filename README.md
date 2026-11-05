# MV Studio

左に **Claude Code のターミナル**、右に **歌詞づくりと曲の一覧** を並べる、ローカルで動く小さなアプリです。
歌詞・スタイル・設定を人と Claude で一緒に作り、Suno に生成を依頼し、できた曲をダウンロードする前に試聴できます。

A small local app: a real **Claude Code terminal** on the left, a **drafting space and your songs** on the right.
Write lyrics, style and settings together with Claude, send them to Suno, and listen to the results *before* spending a
monthly download credit.

> Status: early and deliberately small. Verified on Windows only. / 初期段階で、あえて小さくしています。動作確認は Windows のみです。

## 使い方 / Quick start

必要なもの / Requirements: Node.js 20+, [Claude Code](https://code.claude.com/docs/en/setup), a Suno account.

**Claude Code の導入(まだの場合)** — 公式の手順は [こちら](https://code.claude.com/docs/en/setup)。

| 環境 | コマンド |
|---|---|
| Windows (PowerShell) | `irm https://claude.ai/install.ps1 \| iex` |
| Windows (WinGet) | `winget install Anthropic.ClaudeCode` |
| macOS / Linux / WSL | `curl -fsSL https://claude.ai/install.sh \| bash` |
| macOS (Homebrew) | `brew install --cask claude-code` |

導入後、新しいターミナルで `claude --version` を実行して確認します。初回は `claude` を起動して、ブラウザでログインします(Pro / Max / Team / Enterprise / Console のいずれかが必要です)。

**Claude Code が見つからないとき**: アプリは起動しますが、PJ を開いても Claude は動きません。左のターミナルに導入案内が出て、左端の ⚙ 設定に(赤い点が付き)コマンドと「再確認」ボタンが表示されます。歌詞タブの依頼ボタンは無効になります。導入後は「再確認」を押してください(ネイティブ版の `~/.local/bin/claude` は、再起動なしで見つかります。ほかの導入方法で見つからないときは、アプリを再起動してください — PATH は起動時に読み込まれます)。

```
git clone https://github.com/Genzoh2026/mv-studio.git
cd mv-studio
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
6. 残したい曲だけ、曲のカードの「⬇ ダウンロードを頼む」を押します(ターミナルに依頼が入り、Enter で送信します)。ダウンロード枠を使うので、Claude が実行前に確認します。保存されると、カードはローカルのプレーヤーに切り替わります。

## Claude との流れ / Working with Claude

歌詞タブの 3 つのボタンは、ターミナルに **1 行の依頼を入力するだけ** です。送信(Enter)はあなたが押します。

| ボタン | Claude がすること |
|---|---|
| Claude に確認を頼む | 人の案を読み、歌詞などを完成させて右に出します。**Suno にはまだ投げません** |
| 完成させて生成まで任せる | 完成させて、その内容で Suno に生成を依頼します |
| この案で生成 | 左の案をそのまま Suno に投げます |

- 歌詞が**空のままでも**、曲名とスタイルだけで、Claude が**素案**を提案します(「Claude に確認を頼む」を押します)。
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
- **ツールバーと設定**: 左端の細いバーに、ツールのアイコンが並びます(⚙ 設定、🗑 ゴミ箱、そして下側に離して ⏻ 電源)。バーは「‹」で畳めます(左端の取っ手で開き直し)。⏻ 電源(設定とは別のボタン)では、サーバーの状態を見て、**再起動**と**停止**ができます。どちらも、動いている Claude をすべて終了させるので、確認が出ます。再起動は `start.cmd` から起動したときだけ使えます(終了コード 75 で終了し、`start.cmd` が同じウィンドウで起動し直します)。起動は `launcher.mjs` が担当します。
  - ポートが空いていれば、サーバーを起動して画面を開きます。
  - すでに**最新の** MV Studio が動いていれば、**画面だけ**開きます。
  - **古い**コードの MV Studio が動いていれば、「再起動して最新にする / そのまま開く / 終了」を選べます(再起動すると、そこで動いている Claude が終了します)。最新かどうかは、アプリのファイルの指紋(ハッシュ)で判定します。
  - 別のワークスペースの MV Studio や、別のプログラムがポートを使っているときは、理由を表示して止まります。

## 曲の分離・ビート解析(任意) / Stems and beats (optional)

曲カードのボタンで、**声・ドラム・ベース・その他への分離**(Demucs)と、**キック・スネア・ハイハットの時刻とテンポの解析**ができます。Suno の曲でも、ドラッグ&ドロップで追加した曲でも使えます。この PC の Python で動き、何も外へ送りません。アプリには同梱されず、使わなければ何も要りません。

- 必要なもの: Python 3、ffmpeg、(分離には)Demucs。左端の ⚙ 設定 > 音声ツール に状態が出て、**「音声ツールを導入する」ボタン 1 つ**で、専用環境の作成と Demucs・numpy の導入までを自動で行います(実行内容を確認してから開始、ログ表示、取り消し可。ワークスペースの `.mv-studio/venv` の中だけを変更し、他の Python には触れません。約 0.7 GB)。NVIDIA GPU があれば、GPU 版の PyTorch(+約 3 GB)も選べます。Python と ffmpeg は PC 全体に入れるものなので、コマンドを案内するだけです。ビート解析だけなら numpy と ffmpeg で動きます。
- Windows では、ワークスペースのパスが深いと(目安 90 文字超)、PyTorch のファイルがパス長の上限に当たって導入に失敗することがあります。その場合は画面に警告が出ます。
- 結果は曲の横のファイルです: `<曲>.stems/{vocals,drums,bass,other}.wav` と `<曲>.beats.json`。Claude は読めますが、書きません。
- 分離しておくと、ビート解析はドラムのステムを使って、より正確になります。**BPM は推定値**です(倍・半分になりがち)。時刻のほうを信頼してください。
- 分離は 1 本ずつ実行します。CPU でも動きます(曲 1 分で数十秒〜数分)。NVIDIA の GPU を使うには、PyTorch の CUDA 版が必要です。

Song cards can **split a song into vocals / drums / bass / other** (Demucs) and **find kick / snare / hat times and a tempo estimate**, for Suno songs and for songs you drop in. Everything runs with the Python on your computer and nothing is uploaded; nothing is bundled, and you need none of it unless you use these buttons. Settings > Audio tools has a one-button setup that creates an environment inside the workspace (`.mv-studio/venv`) and installs Demucs and numpy there (shown and confirmed first, with a log and cancel; no other Python is touched; about 0.7 GB, plus about 3 GB if you choose the GPU build of PyTorch). Python 3 and ffmpeg are system-wide, so for those it only shows the commands. The beat analysis needs only numpy and ffmpeg. Results are files beside the song (`<song>.stems/`, `<song>.beats.json`) that Claude can read but not write. The tempo is an estimate (double / half errors are common); trust the hit times.

## 動画へのピン(修正指示) / Review pins on videos

動画ライブラリで動画を開くと、動画の上に「ピン」を打てます。「ピンを打つ」をオンにして直したい場所をクリックすると、その時刻と位置にピンが付きます。コメントを書いて「Claudeに修正を依頼」を押すと、Claude の入力欄に指示が入ります(Enter で送信)。ピンは動画の隣の `<名前>.review.json` に保存され、指示は `<名前>.review.md` に書かれます。Claude は修正を新しいバージョン(`-v2`)として出力し、直したピンを MCP ツール `resolve_review_pins` で報告します。アプリは「送信済みで、送信より新しい動画がある」ピンだけを「修正済み」にします。

Open a video in the video library, turn on "ピンを打つ" and click the picture to pin a time and place with a comment. "Claudeに修正を依頼" puts the request into Claude's input and writes `<name>.review.md`. Claude fixes it as a new version and reports with `resolve_review_pins`; only pins that were sent, with a newer video written afterwards, become done.

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
