# MV Studio

[日本語はこのページの下にあります / Japanese follows below](#日本語)

A local app: a real **Claude Code terminal** on the left, and the **assets and results of a music video** on the right.
Write lyrics and style with Claude and make songs with Suno, keep songs, images and videos in libraries, and pin comments on a video to tell Claude what to fix.

> Status: early. **Windows 10/11 only.** macOS and Linux are not supported and not tested; if you want to run it there, you are welcome to adapt it yourself (MIT).

### What it does

| | |
|---|---|
| Lyrics and songs | Write your draft and Claude's suggestion side by side, ask Suno to generate, listen first, and download only the songs you keep |
| Stems and beats | Split a song into vocals / drums / bass / other with Demucs and find kick / snare / hi-hat times (optional; one-button setup) |
| Image and video libraries | Add by drag and drop. Refer to files by number (#1, #2…) when you talk to Claude. What Claude makes keeps its origin (source data and how it was made) |
| Pins on videos | Comment on a video at a time and place, ask Claude to fix it, and see when it is fixed |
| Trash | Deleting only moves things to `_Trash`; you can restore them. Deleting for good happens from the trash screen, after a confirmation |
| Library (🧩) | A list of skills and plugins that help make videos, with one-button install (into all projects too) |
| Tools for Claude (MCP) | Claude separates songs, analyzes beats and reads and writes pins through the app |
| 日本語 / English | The 🌐 button (above ⏻ in the left bar) switches the screen language. The first time it follows your browser. The request lines sent to Claude and the fix instructions of pins are written in that language too |

## Quick start

Requirements: Windows 10/11, Node.js 20+, [Claude Code](https://code.claude.com/docs/en/setup), a Suno account.

**Install Claude Code (if you have not)** — the official steps are [here](https://code.claude.com/docs/en/setup).

| Environment | Command |
|---|---|
| Windows (PowerShell) | `irm https://claude.ai/install.ps1 \| iex` |
| Windows (WinGet) | `winget install Anthropic.ClaudeCode` |

After installing, run `claude --version` in a new terminal to check. The first time, start `claude` and log in with your browser (a Pro / Max / Team / Enterprise / Console plan is required).

**If Claude Code is not found:** the app still starts, but Claude does not run when you open a project. The terminal on the left shows the install guide, and ⚙ Settings in the left bar (with a red dot) shows the commands and a "Check again" button. The request buttons of the lyrics tab are disabled. After installing, press "Check again" (the native install at `~/.local/bin/claude` is found without a restart; for other install methods, restart the app, because PATH is read at startup).

```
git clone https://github.com/Genzoh2026/mv-studio.git
cd mv-studio
start.cmd [workspace] [port]    # Windows: installs dependencies on first run, opens the browser
# or, anywhere:
npm install
npm start -- [workspace] [port] # same launcher; default port 4200, workspace ../workspace
```

1. In the **project list**, type an MV name and press "+ New". A project is made and Claude starts on the left.
2. The first time, approve Claude's folder trust prompt and sign in to Suno with `/mcp`.
3. In the **Lyrics · style · settings** tab, write the title, style, lyrics and settings in "Your draft" on the left and save.
4. Work with "Claude's suggestion" on the right (see "Working with Claude" below).
5. The songs you make show up in the **Songs** tab. You can listen right there in the Suno player.
6. For the songs you want to keep, press "⬇ Ask Claude to download" on the song card (the request is typed into the terminal; press Enter to send). It uses a download credit, so Claude asks you before it runs. Once saved, the card switches to the local player.

## Working with Claude

The three buttons of the lyrics tab **only type one line of request into the terminal**. You press Enter to send it.

| Button | What Claude does |
|---|---|
| Ask Claude to review | Reads your draft, completes the lyrics etc. and shows them on the right. **Nothing is sent to Suno yet** |
| Let Claude complete it and generate | Completes it and asks Suno to generate with the result |
| Generate with this draft | Sends the draft on the left to Suno as it is |

- Even with **empty lyrics**, Claude proposes a **first draft** from just the title and style (press "Ask Claude to review").
- Your draft and Claude's suggestion are **separate files**. The app writes only your draft and Claude writes only its own, so they never overwrite each other.
- If you like the suggestion on the right, "Bring this draft to the left" copies it (your draft does not change until you save).
- The lyrics have Undo / Redo (Ctrl+Z / Ctrl+Shift+Z).
- If the file is updated outside while you edit, the app shows a notice and blocks saving (to prevent overwriting accidents).
- Suno generation credits are used only by the last two buttons and when you explicitly ask.

## How it works

```
<workspace>/
  PJs/<YYYYMMDD-name>/        one folder per MV (Claude runs here)
    Drafts/<name>.human.json    your draft (only the app writes it)
    Drafts/<name>.claude.json   Claude's suggestion (only Claude writes it)
    Output/song/                <name>.suno.json (preview) -> <name>.mp3 (downloaded)
    Output/image/, Output/video/  images and videos (with <name>.gen.json: where they came from)
  _Trash/                     "deleted" projects and files are moved here, never erased
```

- **The folder is the API**: the app does not call Suno directly. Claude writes files and the app reads them.
- **The rules are handed over at launch**: Claude's behavior (where things go, what the buttons mean, how to generate) is written in `rules/mv-studio.md` and passed with `--append-system-prompt-file` every time. The project's `CLAUDE.md` is for your own notes.
- **Preview**: Claude saves `<name>.suno.json` (ID, title, lyrics, generation settings, etc.) and the app shows Suno's embedded player. When an mp3 of the same name arrives, it switches to the local player.
- **Suno connection**: passed at launch with `claude --mcp-config suno.mcp.json`. Your own Claude settings are not rewritten.
- **Sessions stay**: each project's Claude keeps running when you close the tab or switch projects (up to 5 at a time). End one with "End" in the project list. Stopping the server ends them all.
- **Deleting**: tick projects in the list and press "Move to trash". They only move to `_Trash`; nothing is erased. A running project cannot be moved.
- **Layout**: drag the border between the terminal and the right side to resize (double-click to reset).
- **Tool bar and settings**: a slim bar on the far left holds the tool icons (⚙ Settings, 🧩 Library, 🗑 Trash, 🌐 Language, and ⏻ Power, set apart at the bottom). Fold the bar with "‹" (a handle on the edge opens it again). ⏻ Power (a separate button from Settings) shows the server's state and offers **Restart** and **Stop**. Both end every running Claude, so they ask first. Restart works only when started from `start.cmd` (it exits with code 75 and `start.cmd` starts it again in the same window). `launcher.mjs` handles starting:
  - If the port is free, it starts the server and opens the page.
  - If an **up-to-date** MV Studio is already running, it **only opens the page**.
  - If an **older** MV Studio is running, you can choose "Restart to update / Open as it is / Quit" (restarting ends the Claude sessions running there). Whether it is up to date is decided from a fingerprint (hash) of the app's files.
  - If an MV Studio of another workspace, or another program, uses the port, it stops and shows why.

## Stems and beats (optional)

Song cards can **split a song into vocals / drums / bass / other** (Demucs) and **find kick / snare / hi-hat times and a tempo estimate**, for Suno songs and for songs you drop in. Everything runs with the Python on your computer and nothing is uploaded; nothing is bundled, and you need none of it unless you use these buttons.

- Needed: Python 3, ffmpeg, and (for separation) Demucs. ⚙ Settings > Audio tools shows the state, and **one "Install audio tools" button** creates a dedicated environment and installs Demucs and numpy automatically (shown and confirmed first, with a log and cancel; only `.mv-studio/venv` in the workspace is changed and no other Python is touched; about 0.7 GB). With an NVIDIA GPU you can also choose the GPU build of PyTorch (about 3 GB more). Python and ffmpeg are system-wide, so for those it only shows the commands. Beat analysis alone needs only numpy and ffmpeg.
- On Windows, if the workspace path is deep (over about 90 characters), PyTorch's files can hit the path length limit and the install can fail. The screen warns you in that case.
- Results are files beside the song: `<song>.stems/{vocals,drums,bass,other}.wav` and `<song>.beats.json`. Claude can read them but does not write them.
- If you separate first, beat analysis uses the drums stem and is more accurate. The **BPM is an estimate** (double / half errors are common); trust the hit times.
- Separation runs one at a time. It works on a CPU too (tens of seconds to a few minutes per minute of song). Using an NVIDIA GPU needs the CUDA build of PyTorch.

## Review pins on videos

Open a video in the video library, turn on "Place a pin" and click the spot you want fixed to put a pin at that time and place. Write a comment and press "Ask Claude to fix" to put the instruction into Claude's input (press Enter to send). Pins are saved next to the video as `<name>.review.json`, and the instruction is written to `<name>.review.md`. Claude writes the fix as a new version (`-v2`) and reports the fixed pins with the MCP tool `resolve_review_pins`. The app marks a pin as fixed only when it was sent and a video newer than the sending exists.

## Security

- It listens on `127.0.0.1` only. In the browser, open `http://127.0.0.1:<port>` or `http://localhost:<port>`. Any connection under another name (DNS rebinding, where another site points its own name at your computer) is refused.
- The APIs that change files, and the WebSocket (terminal), accept requests only from the app's own page (same origin).
- The terminal runs a shell on your PC. **Do not expose the port to the outside.**
- The text a button types into the terminal is one line only; line breaks and control characters are refused (nothing is sent on its own).
- Audio, images and videos are served only from a project's `Output/`.
- The tools for Claude (MCP) are protected by a per-project token derived from a secret made at every start, and touch only that project. They cannot delete anything or touch the trash.
- The install buttons of the 🧩 Library **download and run third-party skills and plugins**. Only commands of a fixed form written in the bundled list (`catalog/video-tools.json`) can run; the commands and the place are shown in a confirmation screen and run only when you approve. By default they install only inside the project (project scope), and your own Claude settings do not change. Check what you install at its source.

## Known limits

- Windows only (macOS / Linux are out of scope). `Output` and `output` are the same folder on Windows.
- It is untested whether the embedded player of a private song plays in a browser that is not signed in to Suno.
- "Let Claude complete it and generate" and "Generate with this draft" use Suno credits, so they could not be verified end to end during development.
- It depends on Claude writing `Drafts/*.claude.json` and `suno.json` as the rules say (a broken file is shown as an error on screen and the file is left untouched).
- How many songs one generation makes is up to Suno. Every song that comes back becomes a card.
- The pin flow (request → Claude's new version → marked fixed) was confirmed by the author with a real Claude on one machine; other setups and complex fix instructions are untested.
- Actually installing a third-party plugin with the Library's install button has not been verified end to end (building the commands and running them in order are tested).
- The English screen texts were written for this release and have had little review; wording fixes are welcome.

## Tests

`npm test` (Node's built-in test runner) runs the automated tests. They cover file handling, the trash, numbering, pins, MCP, the check of install commands, the server's host and origin checks, and that every screen text has an English version. A real Claude, Suno and Demucs are not used.

## License

MIT. See [LICENSE](LICENSE).

---

# 日本語

[English is above / 英語は上にあります](#mv-studio)

左に **Claude Code のターミナル**、右に **MV づくりの素材と作品** を並べる、ローカルで動くアプリです。
歌詞・スタイルを Claude と作って Suno で曲にし、曲・画像・動画をライブラリで管理し、動画には「ピン」で修正指示を出せます。

> 状態: 初期段階です。**Windows 10/11 専用**です。macOS・Linux は対象外で、動作も確認していません(使いたい方は MIT ライセンスの範囲でご自由に改造してください)。

### できること

| | |
|---|---|
| 歌詞・曲 | 人の案と Claude の案を並べて作り、Suno に生成を依頼。聴いてから、残す曲だけダウンロード |
| 曲の分離・ビート解析 | Demucs で声・ドラム・ベース・その他に分け、キック・スネア・ハイハットの時刻を解析(任意。ワンボタンで導入) |
| 画像・動画ライブラリ | ドラッグ&ドロップで追加。番号(#1, #2…)で Claude に指示。Claude が作ったものには出所(元データ・生成方法)を記録 |
| 動画へのピン | 動画の時刻と位置にコメントを付け、Claude に修正を依頼。直ったかを確認できる |
| ゴミ箱 | 削除は `_Trash` への移動だけ。戻せる。完全削除はゴミ箱画面で確認してから |
| ライブラリ(🧩) | 動画づくりに役立つスキル・プラグインの一覧と、ワンボタン導入(全プロジェクトに導入も可) |
| Claude 用ツール(MCP) | Claude が曲の分離・ビート解析・ピンの読み書きをアプリ経由で行う |
| 日本語 / English | 左端の 🌐(⏻ の上)で画面の言語を切り替え。初回はブラウザの言語に合わせる。Claude に送る指示文やピンの修正指示も、その言語で書かれる |

## 使い方

必要なもの: Windows 10/11、Node.js 20 以上、[Claude Code](https://code.claude.com/docs/en/setup)、Suno のアカウント。

**Claude Code の導入(まだの場合)** — 公式の手順は [こちら](https://code.claude.com/docs/en/setup)。

| 環境 | コマンド |
|---|---|
| Windows (PowerShell) | `irm https://claude.ai/install.ps1 \| iex` |
| Windows (WinGet) | `winget install Anthropic.ClaudeCode` |

導入後、新しいターミナルで `claude --version` を実行して確認します。初回は `claude` を起動して、ブラウザでログインします(Pro / Max / Team / Enterprise / Console のいずれかが必要です)。

**Claude Code が見つからないとき**: アプリは起動しますが、PJ を開いても Claude は動きません。左のターミナルに導入案内が出て、左端の ⚙ 設定に(赤い点が付き)コマンドと「再確認」ボタンが表示されます。歌詞タブの依頼ボタンは無効になります。導入後は「再確認」を押してください(ネイティブ版の `~/.local/bin/claude` は、再起動なしで見つかります。ほかの導入方法で見つからないときは、アプリを再起動してください — PATH は起動時に読み込まれます)。

```
git clone https://github.com/Genzoh2026/mv-studio.git
cd mv-studio
start.cmd [workspace] [port]    # Windows: 初回は依存パッケージを入れ、ブラウザを開きます
# どこからでも:
npm install
npm start -- [workspace] [port] # 同じ起動処理。既定は ポート 4200、workspace ../workspace
```

1. **PJ一覧**で「+ 新規」から MV の名前を入力 → PJ ができ、左で Claude が起動します。
2. 初回は Claude のフォルダ信頼を承認し、`/mcp` で Suno にサインインします。
3. **歌詞・スタイル・設定** タブで、左の「人の案」に曲名・スタイル・歌詞・設定を書いて保存します。
4. 右の「Claude の修正案」を見ながら進めます(下の「Claude との流れ」)。
5. できた曲は **曲ライブラリ** タブに出ます。Suno のプレーヤーでその場で聴けます。
6. 残したい曲だけ、曲のカードの「⬇ ダウンロードを頼む」を押します(ターミナルに依頼が入り、Enter で送信します)。ダウンロード枠を使うので、Claude が実行前に確認します。保存されると、カードはローカルのプレーヤーに切り替わります。

## Claude との流れ

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

## 仕組み

```
<workspace>/
  PJs/<YYYYMMDD-name>/        MV ごとに 1 フォルダ(Claude はここで動く)
    Drafts/<名前>.human.json    あなたの案(アプリだけが書く)
    Drafts/<名前>.claude.json   Claude の案(Claude だけが書く)
    Output/song/                <名前>.suno.json(試聴) → <名前>.mp3(ダウンロード済み)
    Output/image/, Output/video/  画像と動画(<名前>.gen.json に出所を記録)
  _Trash/                     「削除」した PJ やファイルはここへ移るだけ(消えない)
```

- **フォルダが API**: アプリは Suno を直接呼びません。Claude がファイルを書き、アプリが読みます。
- **ルールは起動時に渡す**: Claude の振る舞い(保存場所、ボタンの意味、生成の手順)は `rules/mv-studio.md` に書かれ、`--append-system-prompt-file` で毎回渡されます。PJ の `CLAUDE.md` はあなたのメモ用です。
- **試聴**: Claude が `<name>.suno.json`(ID、タイトル、歌詞、生成時の指定など)を保存し、アプリが Suno の埋め込みプレーヤーを表示します。同名の mp3 が入るとローカルのプレーヤーに切り替わります。
- **Suno の接続**: `claude --mcp-config suno.mcp.json` で起動時に渡します。あなたの Claude の設定は書き換えません。
- **セッション保持**: PJ ごとの Claude はタブを閉じても、PJ を切り替えても動き続けます(同時に 5 つまで)。PJ一覧の「終了」で止めます。サーバーを止めると、すべて終了します。
- **削除**: PJ一覧でチェックして「ゴミ箱へ移動」。`_Trash` へ移るだけで、完全には消えません。実行中の PJ は移せません。
- **画面**: 左のターミナルと右の境界はドラッグで動かせます(ダブルクリックで元に戻る)。
- **ツールバーと設定**: 左端の細いバーに、ツールのアイコンが並びます(⚙ 設定、🧩 ライブラリ、🗑 ゴミ箱、🌐 言語、そして下側に離して ⏻ 電源)。バーは「‹」で畳めます(左端の取っ手で開き直し)。⏻ 電源(設定とは別のボタン)では、サーバーの状態を見て、**再起動**と**停止**ができます。どちらも、動いている Claude をすべて終了させるので、確認が出ます。再起動は `start.cmd` から起動したときだけ使えます(終了コード 75 で終了し、`start.cmd` が同じウィンドウで起動し直します)。起動は `launcher.mjs` が担当します。
  - ポートが空いていれば、サーバーを起動して画面を開きます。
  - すでに**最新の** MV Studio が動いていれば、**画面だけ**開きます。
  - **古い**コードの MV Studio が動いていれば、「再起動して最新にする / そのまま開く / 終了」を選べます(再起動すると、そこで動いている Claude が終了します)。最新かどうかは、アプリのファイルの指紋(ハッシュ)で判定します。
  - 別のワークスペースの MV Studio や、別のプログラムがポートを使っているときは、理由を表示して止まります。

## 曲の分離・ビート解析(任意)

曲カードのボタンで、**声・ドラム・ベース・その他への分離**(Demucs)と、**キック・スネア・ハイハットの時刻とテンポの解析**ができます。Suno の曲でも、ドラッグ&ドロップで追加した曲でも使えます。この PC の Python で動き、何も外へ送りません。アプリには同梱されず、使わなければ何も要りません。

- 必要なもの: Python 3、ffmpeg、(分離には)Demucs。左端の ⚙ 設定 > 音声ツール に状態が出て、**「音声ツールを導入する」ボタン 1 つ**で、専用環境の作成と Demucs・numpy の導入までを自動で行います(実行内容を確認してから開始、ログ表示、取り消し可。ワークスペースの `.mv-studio/venv` の中だけを変更し、他の Python には触れません。約 0.7 GB)。NVIDIA GPU があれば、GPU 版の PyTorch(+約 3 GB)も選べます。Python と ffmpeg は PC 全体に入れるものなので、コマンドを案内するだけです。ビート解析だけなら numpy と ffmpeg で動きます。
- Windows では、ワークスペースのパスが深いと(目安 90 文字超)、PyTorch のファイルがパス長の上限に当たって導入に失敗することがあります。その場合は画面に警告が出ます。
- 結果は曲の横のファイルです: `<曲>.stems/{vocals,drums,bass,other}.wav` と `<曲>.beats.json`。Claude は読めますが、書きません。
- 分離しておくと、ビート解析はドラムのステムを使って、より正確になります。**BPM は推定値**です(倍・半分になりがち)。時刻のほうを信頼してください。
- 分離は 1 本ずつ実行します。CPU でも動きます(曲 1 分で数十秒〜数分)。NVIDIA の GPU を使うには、PyTorch の CUDA 版が必要です。

## 動画へのピン(修正指示)

動画ライブラリで動画を開くと、動画の上に「ピン」を打てます。「ピンを打つ」をオンにして直したい場所をクリックすると、その時刻と位置にピンが付きます。コメントを書いて「Claudeに修正を依頼」を押すと、Claude の入力欄に指示が入ります(Enter で送信)。ピンは動画の隣の `<名前>.review.json` に保存され、指示は `<名前>.review.md` に書かれます。Claude は修正を新しいバージョン(`-v2`)として出力し、直したピンを MCP ツール `resolve_review_pins` で報告します。アプリは「送信済みで、送信より新しい動画がある」ピンだけを「修正済み」にします。

## セキュリティ

- `127.0.0.1` のみで待ち受けます。ブラウザからは `http://127.0.0.1:ポート` か `http://localhost:ポート` で開けます。それ以外の名前での接続(他サイトが名前を付け替えて入る DNS リバインディング)は、すべて拒否します。
- ファイルを変更する API と WebSocket(ターミナル)は、アプリ自身のページ(同一オリジン)からだけ受け付けます。
- ターミナルは、あなたの PC でシェルを動かします。**ポートを外部に公開しないでください。**
- ボタンがターミナルに入力する文字列は 1 行のみで、改行や制御文字は拒否されます(勝手に送信されません)。
- 音声・画像・動画は、PJ の `Output/` 内のものだけを配信します。
- Claude 用ツール(MCP)は、起動のたびに作られる秘密から導いた PJ ごとのトークンで守られ、その PJ にしか触れません。削除やゴミ箱の操作はできません。
- 🧩 ライブラリの導入ボタンは、**第三者のスキル・プラグインを取得して実行します**。実行できるのは、同梱の一覧(`catalog/video-tools.json`)に書かれた決まった形のコマンドだけで、実行前にコマンドと場所を確認画面に出し、あなたが承認したときだけ動きます。既定ではプロジェクト内(project 範囲)にだけ入り、あなたの Claude 全体の設定は変わりません。導入するものの内容は、配布元で確認してください。

## 既知の制限

- Windows 専用です(macOS / Linux は対象外)。`Output`(大文字)と `output`(小文字)は、Windows では同じフォルダ扱いです。
- Suno にサインインしていないブラウザで、非公開曲の埋め込みが再生できるかは未確認です。
- 「完成させて生成まで任せる」「この案で生成」は、Suno の生成枠を使うため、開発中は通しで検証できていません。
- Claude が `Drafts/*.claude.json` や `suno.json` を、ルールどおりに書くことに依存しています(壊れていた場合は、画面にエラーを出し、ファイルには触れません)。
- 1 回の生成で何曲できるかは Suno 側の仕様です。返ってきた曲は全部カードになります。
- 動画へのピン(依頼 → Claude の修正版 → 修正済み)は、作者が実機の Claude で 1 台の環境で通しの動作を確認しています。ほかの環境や、複雑な修正の指示は未検証です。
- ライブラリの導入ボタンで第三者のプラグインを実際に入れる動作は、通しでは検証していません(コマンドの組み立てと実行順はテスト済みです)。
- 英語の画面の文言は、このリリースのために書いたもので、確認はまだ十分ではありません。言い回しの修正は歓迎します。

## テスト

`npm test`(Node 組み込みのテストランナー)で、自動テストが動きます。ファイルの扱い、ゴミ箱、番号、ピン、MCP、導入コマンドの検査、サーバーのホスト・オリジン検査、すべての画面の文言に英語版があることなどを確認します。実機の Claude・Suno・Demucs は使いません。

## ライセンス

MIT。[LICENSE](LICENSE) を参照してください。
