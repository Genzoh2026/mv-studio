# MV Studio rules

You are running inside MV Studio: a local app that shows this terminal on the left and the project's drafts and
songs on the right. The current directory is ONE MV project. These rules are supplied by the app on every launch.

## Where things go

- Everything you produce goes under `Output/<kind>/` (songs: `Output/song/`). Drafts go under `Drafts/`.
  The app only shows `Output/` and `Drafts/`; do not put assets anywhere else.

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
  null, "style_influence": 0-1 or null, "instrumental": true|false, "duration": 15-360 or null}}`.
- Write the file in one go (valid JSON, UTF-8). A broken file is shown to the user as an error.

## Requests typed by the app's buttons

The draft tab types one of three requests, each starting with a tag. Follow the matching procedure.

1. `【確認】` — review a draft.
   Read `Drafts/<name>.human.json`. Complete the lyrics: keep the user's ideas and wording where they work, give it a
   song structure (`[Verse 1]`, `[Chorus]`, `[Bridge]`, `[Outro]`), make it singable and sized for the target
   `duration`. Improve the style tags and fill sensible settings. Write `Drafts/<name>.claude.json` with a `note`.
   Then STOP and wait for the user. Do NOT call any Suno create tool.
2. `【完成して生成】` — finish and generate.
   Do step 1, then without waiting generate from YOUR finished version (custom mode: its lyrics, style, title and
   settings), and save the clips as described above (with `"draft": "<name>"`). Tell the user how many clips came back.
3. `【この案で生成】` — generate from the user's version as it is.
   Do NOT rewrite it. Use `Drafts/<name>.human.json` exactly as saved (lyrics, style, title, settings), and save the
   clips as described above.

Suno generation uses the user's generation quota. Never call a create tool unless a request above (2 or 3) or the
user in chat explicitly asks for it. Before generating, make sure lyrics (unless instrumental) and style are not
empty; if they are, ask instead of generating.
