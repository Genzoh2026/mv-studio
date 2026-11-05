// English texts for what the server writes: install steps, the install guide for Claude Code, job errors, and the texts Claude reads
// (the fix instructions of review pins). The key is the Japanese text in the code (see messages.mjs). npm test checks that every
// text used in the code is here and that no Japanese is left in a value.
export const MESSAGES_EN = {
  // audio tools: what is missing and the commands to fix it
  "Python 3 を入れる": "Install Python 3",
  "入れたら、アプリの「再確認」を押します(PATH は起動時に読み込まれるので、見つからなければアプリを再起動してください)。PyTorch が対応するのは Python 3.9〜3.12 ごろまでです":
    "After installing, press \"Check again\" in the app (PATH is read at startup, so restart the app if it is still not found). PyTorch supports Python up to about 3.9-3.12.",
  "ffmpeg を入れる": "Install ffmpeg",
  "専用の環境を作る(ワークスペースの中。他の Python を汚しません)": "Create a dedicated environment (inside the workspace; no other Python is touched)",
  "Demucs を入れる(曲の分離に必要。数 GB のダウンロードがあります)": "Install Demucs (needed for song separation; several GB of downloads)",
  "Demucs が読み込めません({missing} がありません)。足りないものを入れる": "Demucs cannot be loaded ({missing} is missing). Install what is missing",
  "Demucs が読み込めません。入れ直す": "Demucs cannot be loaded. Reinstall it",
  "numpy を入れる(ビート解析に必要)": "Install numpy (needed for beat analysis)",
  "GPU({gpu})で速くする: GPU 版の PyTorch に入れ替える(約 3 GB。任意)": "Speed up with the GPU ({gpu}): switch to the GPU build of PyTorch (about 3 GB; optional)",
  "PyTorch 公式の手順です(https://pytorch.org/get-started/locally/)。入れ替えたら「再確認」で「GPU が使えます」になれば成功です。GPU がなくても分離は動きます(CPU は遅めです)。":
    "These are PyTorch's official steps (https://pytorch.org/get-started/locally/). After switching, press \"Check again\": if it says the GPU can be used, it worked. Separation also works without a GPU (the CPU is slower).",

  // the one-button audio setup
  "Python 3 が見つかりません。先に Python を入れてください(下の手順)。": "Python 3 was not found. Install Python first (see the steps below).",
  "専用の環境を作る": "Create a dedicated environment",
  "GPU 版の PyTorch を入れる": "Install the GPU build of PyTorch",
  "Demucs と numpy を入れる": "Install Demucs and numpy",
  "この場所は、パスが長すぎます({n} 文字)。Windows の上限(260 文字)のため、導入が途中で失敗することがあります。MV Studio のフォルダを、もっと短い場所(例: C:\\mvs)に置くか、Windows の「長いパスを有効にする」設定を使ってください。":
    "This location's path is too long ({n} characters). Because of Windows' limit (260 characters), the installation may fail partway. Put the MV Studio folder in a shorter location (e.g. C:\\mvs) or use Windows' \"Enable long paths\" setting.",

  // Claude Code is missing: the guide printed in the terminal
  "Claude Code が見つかりません。": "Claude Code was not found.",
  "公式の導入手順: {url}": "Official install guide: {url}",
  "導入したら、新しいターミナルで  claude --version  を実行して確認し、": "After installing, run  claude --version  in a new terminal to check,",
  "アプリの ⚙ 設定 →「再確認」を押してください。": "then press ⚙ Settings → \"Check again\" in the app.",
  "それでも見つからないときは、このアプリを再起動してください(PATH は起動時に読み込まれます)。": "If it is still not found, restart this app (PATH is read at startup).",
  "初回は claude を起動し、ブラウザでログインします(Pro / Max / Team / Enterprise / Console のいずれかが必要です)。": "The first time, start claude and log in with your browser (a Pro / Max / Team / Enterprise / Console plan is required).",

  // song jobs
  "Python に {missing} が入っていません。左端の ⚙ 設定 > 音声ツール の手順で入れて、「再確認」を押してください。": "{missing} is not installed in Python. Install it with the steps in ⚙ Settings > Audio tools on the left bar, then press \"Check again\".",
  "音声ツールの導入中です。終わってからやり直してください": "The audio tools are being installed. Try again when it finishes.",

  // review pins: what Claude reads
  "# 動画 #{id} {name} の修正指示": "# Fix instructions for video #{id} {name}",
  "- 元の動画は上書きせず、新しいバージョン(例: `-v2`)として出力してください。`.gen.json` の `parent` に元の動画を書いてください。": "- Do not overwrite the original video; write a new version (e.g. `-v2`). Put the original video in `parent` of its `.gen.json`.",
  "- 直したら、MCP ツール `resolve_review_pins` で、直したピン番号と新しい動画のファイル名を報告してください。": "- When done, report the fixed pin numbers and the new video's file name with the MCP tool `resolve_review_pins`.",
  "- 位置は画面の左上を 0%・0% とした割合です。位置がないものは、その時刻の動画全体への指示です。": "- A position is a percentage from the top left of the picture (0%, 0%). A pin without a position is an instruction for the whole picture at that time.",
  "- 【修正】ピン{id} {time} {place} {text}": "- [Fix] Pin {id} {time} {place} {text}",
  "(全体)": "(whole picture)",
  "動画 #{id}({name})の修正指示を Output/video/{file} に書きました。読んで、新しいバージョンとして直してください。": "I wrote the fix instructions for video #{id} ({name}) to Output/video/{file}. Read them and fix the video as a new version.",
};
