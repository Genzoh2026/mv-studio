# MV Studio rules

You are running inside MV Studio: a local app that shows this terminal on the left and the project's drafts and
songs on the right. The current directory is ONE MV project. These rules are supplied by the app on every launch.

## Where things go

- Everything you produce goes under `Output/<kind>/` (songs: `Output/song/`). Drafts go under `Drafts/`.
  The app only shows `Output/` and `Drafts/`; do not put assets anywhere else.
- `Output/image/` is the image library. The user drops their own images there through the app; read them freely
  (look at them with the Read tool), but NEVER modify, rename or delete them. Images you create go to the same
  folder under a new name (png, jpg, webp or gif; the app does not show other formats).
- Every image has an id (1, 2, 3, ...), shown in the app as `#3`. The ledger is `Output/image/index.json`
  (`items: [{id, name}]`); only the app writes it. When the user says "image 3", "画像3" or "#3", look the id up there
  and use that file. If the id is missing, the image was trashed or never seen by the app: say so instead of guessing.
  A file you just saved has no id until the app notices it, so refer to your own new images by file name.

## Songs: preview first, download only on request

- Suno downloads are limited per month, so NEVER download right after creating a song.
  Once a clip exists, save `Output/song/<name>.suno.json`:
  `{"id": "<clip id>", "title": "", "duration": <seconds>, "style": "", "lyrics": "", "cover": "<cover_image_url>",
  "type": "<metadata.type>", "created_at": "<created_at>", "draft": "<draft name, if any>", "settings": {...}}`
  - `cover` is the clip's `cover_image_url` (the PJ list uses it as the thumbnail).
  - `settings` = exactly what YOU passed to the create call (model, mode, instrumental, vocal_gender, weirdness,
    style_influence, negative_style, target duration, ...) as flat key/value pairs. Suno cannot return these later.
  - The app shows an embedded Suno player from this file, so the user can listen before deciding.
- One generation can return several clips (`clip_ids`; Suno decides how many). Save ALL of them, one file per clip:
  `<title>-1.suno.json`, `<title>-2.suno.json`, ... (a single clip needs no suffix). Previewing costs no download
  credit, so never drop a clip yourself; the user picks.
- Download only the songs the user picks (ask first; it may spend a download credit) and save the mp3 as
  `Output/song/<name>.mp3`, the same name as its `.suno.json`. The app then switches to the local player.

## Drafts: lyrics, style and settings made together

Each draft has two files in `Drafts/`, each with exactly ONE owner:

- `Drafts/<name>.human.json` is the user's version. Read it. NEVER edit it.
- `Drafts/<name>.claude.json` is yours. Same fields plus `"note"` (one or two sentences, in Japanese: what you
  changed and why). The app shows the two side by side and lets the user take yours over.
- Fields: `{"title": "", "style": "", "lyrics": "", "settings": {"vocal_gender": "male|female|", "weirdness": 0-1 or
  null, "style_influence": 0-1 or null, "audio_influence": 0-1 or null, "instrumental": true|false,
  "duration": 15-360 or null, "mode": "new|cover", "source_id": "", "source_title": "", "voice_id": "",
  "voice_name": "", "negative_style": ""}}`. A claude.json must keep the user's `mode`, `source_id` and `voice_id`
  unless you explain the change in the `note`.
- Write the file in one go (valid JSON, UTF-8). A broken file is shown to the user as an error.

## Requests typed by the app's buttons

The app types one of these requests, each starting with a tag (1-3 and 5 from the draft tab, 4 and 6 from a song card). Follow the matching procedure.

1. `【確認】` — review a draft.
   Read `Drafts/<name>.human.json`. If the lyrics are EMPTY (the user gave only a title, style or settings), write an original first draft (a "素案") from them for the user to react to, and say so in the `note`. Otherwise complete the lyrics: keep the user's ideas and wording where they work, give it a
   song structure (`[Verse 1]`, `[Chorus]`, `[Bridge]`, `[Outro]`), make it singable and sized for the target
   `duration`. Improve the style tags and fill sensible settings. Write `Drafts/<name>.claude.json` with a `note`.
   Then STOP and wait for the user. Do NOT call any Suno create tool.
2. `【完成して生成】` — finish and generate.
   Do step 1, then without waiting generate from YOUR finished version (custom mode: its lyrics, style, title and
   settings), and save the clips as described above (with `"draft": "<name>"`). Tell the user how many clips came back.
3. `【この案で生成】` — generate from the user's version as it is.
   Do NOT rewrite it. Use `Drafts/<name>.human.json` exactly as saved (lyrics, style, title, settings), and save the
   clips as described above.

### How a draft is generated, by `settings.mode`

Use these for requests 2 and 3. Pass an option only when it is set (non-empty, non-null); never invent one.

- `new` (default): `audio-create` in custom mode: `lyrics`, `style`, `title`, `negative_style`, `weirdness`,
  `style_influence`, `vocal_gender`, `instrumental`, `duration`. If `voice_id` is set, pass it (a voice always sings,
  and `vocal_gender` is then ignored by Suno; `audio_influence` is valid ONLY together with a `voice_id`).
- `cover`: `audio-covers-create` with `id` = `source_id`. If `source_id` is empty, do not generate: ask. The source's
  lyrics are NOT carried over, so always pass the draft's `lyrics` (unless instrumental). A cover takes the source's
  title, so the draft's `title` is only a label for the saved file. Pass `style`, `negative_style`, `voice_id`,
  `duration`, and `audio_influence` / `weirdness` / `style_influence` as `controls`. The source must be `complete`;
  if Suno says it is not, tell the user instead of retrying.
- `controls`, `negative_style` and `vocal_gender` need an advanced-controls grant on the plan. If Suno answers 403
  for them, say so and offer to retry without them; do not drop them silently.
- In the saved `.suno.json`, `settings` must also record `mode`, `source_id` and `voice_id` when used.

Suno generation uses the user's generation quota. Never call a create tool unless a request above (2 or 3) or the
user in chat explicitly asks for it. Before generating, make sure lyrics (unless instrumental) and style are not
empty; if they are, ask instead of generating.
4. `【ダウンロード】` — download ONE song (typed by a song card's button).
   The request names the song and its files. Download only that song, as mp3, with the Suno `audio-download` tool.
   Call it WITHOUT `confirm` first. If the answer says it would spend a download credit (`requires_credit`), ask the
   user in chat and call again with `confirm: true` only after an explicit yes; on a no, stop. Use the returned URL
   exactly as given (it is signed; do not modify it) to fetch the file, save it as `Output/song/<name>.mp3` (the name in
   the request, the same as its `.suno.json`), and tell the user it is saved. Never download any other song.
5. `【Voice更新】` — refresh the voice list (typed by the draft tab's button).
   Call `voices-list` (own voices; follow `next_cursor` until done) and write `Drafts/voices.json` in one go:
   `{"updated_at": "<ISO time>", "voices": [{"id": "<voice id>", "name": "<voice name>"}]}`. Write only id and name,
   nothing else the API returns. Do not call any create tool. Tell the user how many voices were found; if there
   are none, say that a voice is created at the URL from `voices-start` (the user does that on suno.com).
6. `【解析】` — analyse ONE song (typed by a song card's button).
   The request names the song. Take its clip id from `Output/song/<name>.suno.json` (field `id`). Analysis spends no
   credit (measured), but never call a create tool here.
   - Beats: call `audio-analysis`. While `status` is `processing`, call it again (at most 6 calls in all); stop on
     `unavailable`. Save `Output/song/<name>.analysis.json` in one go:
     `{"id": "<clip id>", "bpm": 0, "key": "", "time_signature": 4, "duration_s": 0, "sections": [{"start_s": 0,
     "end_s": 0, "label": "A"}], "beats": [[<time_s>, <bar_position>], ...], "terms": [], "labels": [{"label": "",
     "probability": 0}]}`. Copy every beat exactly as returned (times rounded to 3 decimals); do not thin, summarise
     or invent beats. A part Suno could not produce stays `null` / `[]`.
   - Words: call `audio-lyrics-alignment` the same way (skip for an instrumental). Save
     `Output/song/<name>.lyrics.json` as `{"id": "<clip id>", "words": [ ...one object per word, exactly the
     fields the API returns for it (text and start/end seconds)... ]}`.
   - The responses are long. NEVER paste beats or words into the chat; answer with one line: BPM, key, number of
     sections and beats, number of words, and which part (if any) was unavailable. Do not retry beyond the polling above.
