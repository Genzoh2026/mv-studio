# MV Studio

左に **Claude Code のターミナル**、右に **作った曲(ライブラリ)** を並べる、ローカルで動く小さなアプリです。
Suno で作った曲を、ダウンロード枠を使わずに試聴し、気に入ったものだけを資産として残せます。

A small local app: a real **Claude Code terminal** on the left, your **songs (library)** on the right.
Listen to Suno songs *before* spending a monthly download credit, and keep only the ones you like.

> Status: early and deliberately small. Verified on Windows only. / 初期段階で、あえて小さくしています。動作確認は Windows のみです。

## 使い方 / Quick start

必要なもの / Requirements: Node.js 20+, [Claude Code](https://claude.com/claude-code) (`claude` on PATH), a Suno account.

```
git clone <this repo>
cd <this repo>
start.cmd                       # Windows: installs dependencies on first run, opens the browser
# or, anywhere:
npm install
node server.mjs <workspace>     # default port 4200 (PORT=... to change)
```

1. ライブラリで「+ 新規」から MV の名前を入力 → PJ ができ、左で Claude が起動します。
2. 初回は Claude のフォルダ信頼を承認し、`/mcp` で Suno にサインインします。
3. 「Suno で曲を作って、試聴用に保存して」と頼むと、右にカードが出ます。Suno のプレーヤーでその場で聴けます。
4. 残したい曲だけ、Claude に「ダウンロードして」と頼みます(ダウンロード枠を使うので、都度確認が入ります)。

## 仕組み / How it works

```
<workspace>/
  PJs/<YYYYMMDD-name>/        one folder per MV (Claude runs here)
    CLAUDE.md                 tells Claude where to save things
    Output/song/              <name>.suno.json (preview) -> <name>.mp3 (downloaded)
  _Trash/                     "deleted" projects are moved here, never erased
```

- **フォルダが API**: Claude がファイルを書き、アプリは読むだけです。アプリは Suno の API を直接呼びません。
- **試聴**: Claude が `<name>.suno.json`(ID、タイトル、歌詞など)を保存し、アプリが Suno の埋め込みプレーヤー(`suno.com/embed/<id>`)を表示します。同名の mp3 が入るとローカルのプレーヤーに切り替わります。
- **Suno の接続**: アプリが `claude --mcp-config suno.mcp.json` で起動時に渡します。あなたの Claude の設定は書き換えません。
- **セッション保持**: PJ ごとの Claude はタブを閉じても、PJ を切り替えても動き続けます(同時に 5 つまで)。ライブラリの「終了」で止めます。
- **削除**: ライブラリでチェックして「ゴミ箱へ移動」。`_Trash` へ移るだけで、完全には消えません。実行中の PJ は移せません。

## セキュリティ / Security

- `127.0.0.1` のみで待ち受けます。WebSocket とフォルダを変更する API は同一オリジンのみ受け付けます。
- ターミナルは、あなたの PC でシェルを動かします。**ポートを外部に公開しないでください。**
- 音声ファイルは、PJ の `Output/` 内のものだけを配信します。

## 既知の制限 / Known limits

- Windows 以外(macOS / Linux)は未確認です。`Output`(大文字)と `output`(小文字)は、Windows では同じフォルダ扱いです。
- Suno にサインインしていないブラウザで、非公開曲の埋め込みが再生できるかは未確認です。
- 1 回の生成で何曲できるかは Suno 側の仕様です。返ってきた曲は全部カードになります。
- 自動テストはありません。

## ライセンス / License

MIT. See [LICENSE](LICENSE).
