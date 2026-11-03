// Song drafts: <project>/Drafts/<name>.human.json (the user's version) and <name>.claude.json (Claude's
// suggestion). Each side owns exactly one file: the app only ever writes the human file, Claude only the
// other, so the two never overwrite each other.
import { mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

const DRAFT_NAME = /^[\p{L}\p{N}_-]{1,64}$/u;
const HUMAN_EXT = ".human.json";
const CLAUDE_EXT = ".claude.json";
const LIMITS = { title: 200, style: 2000, lyrics: 20000, note: 1000 };
const VOCALS = new Set(["", "male", "female"]);
// How the song is made. Extend and mashup are added later; an unknown mode is rejected rather than guessed.
const MODES = new Set(["new", "cover"]);
const NEGATIVE_STYLE_MAX = 1000;
const LABEL_MAX = 200;
const VOICES_FILE = "voices.json";
const VOICES_MAX = 200;
// Suno ids end up in tool calls, so only a UUID (clip) or a plain token (voice) is accepted.
const CLIP_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const VOICE_ID = /^[\w-]{1,100}$/;
const DURATION_RANGE = [15, 360];

export class ConflictError extends Error {}
export class ValidationError extends Error {}

export const isDraftName = (name) => typeof name === "string" && DRAFT_NAME.test(name);

function text(data, key) {
  const value = data[key] ?? "";
  if (typeof value !== "string") throw new ValidationError(`${key} must be text`);
  if (value.length > LIMITS[key]) throw new ValidationError(`${key} is too long (max ${LIMITS[key]})`);
  return value;
}

function fraction(value, key) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "number" || !(value >= 0 && value <= 1)) throw new ValidationError(`${key} must be 0-1`);
  return value;
}

function cleanSettings(settings = {}) {
  if (typeof settings !== "object" || settings === null || Array.isArray(settings)) {
    throw new ValidationError("settings must be an object");
  }
  const vocal = settings.vocal_gender ?? "";
  if (!VOCALS.has(vocal)) throw new ValidationError("vocal_gender must be male, female or empty");
  const duration = settings.duration ?? null;
  if (duration !== null && !(Number.isInteger(duration) && duration >= DURATION_RANGE[0] && duration <= DURATION_RANGE[1])) {
    throw new ValidationError(`duration must be an integer ${DURATION_RANGE[0]}-${DURATION_RANGE[1]}`);
  }
  const mode = settings.mode ?? "new";
  if (!MODES.has(mode)) throw new ValidationError(`mode must be one of: ${[...MODES].join(", ")}`);
  const sourceId = settings.source_id ?? "";
  if (sourceId !== "" && !CLIP_ID.test(sourceId)) throw new ValidationError("source_id must be a Suno song id");
  // A cover without a source is a draft in progress: it saves, but the UI and rules refuse to generate it.
  const voiceId = settings.voice_id ?? "";
  if (voiceId !== "" && !VOICE_ID.test(voiceId)) throw new ValidationError("voice_id has invalid characters");
  return {
    vocal_gender: vocal,
    weirdness: fraction(settings.weirdness, "weirdness"),
    style_influence: fraction(settings.style_influence, "style_influence"),
    audio_influence: fraction(settings.audio_influence, "audio_influence"),
    instrumental: settings.instrumental === true,
    duration,
    mode,
    source_id: sourceId,
    source_title: label(settings.source_title, "source_title"),
    voice_id: voiceId,
    voice_name: label(settings.voice_name, "voice_name"),
    negative_style: label(settings.negative_style, "negative_style", NEGATIVE_STYLE_MAX),
  };
}

function label(value, key, max = LABEL_MAX) {
  const result = value ?? "";
  if (typeof result !== "string" || result.length > max) throw new ValidationError(`${key} must be text up to ${max} characters`);
  return result;
}

/** Validate a draft from either side. Throws ValidationError. */
export function cleanDraft(data) {
  if (typeof data !== "object" || data === null || Array.isArray(data)) throw new ValidationError("draft must be an object");
  return {
    title: text(data, "title"),
    style: text(data, "style"),
    lyrics: text(data, "lyrics"),
    settings: cleanSettings(data.settings),
  };
}

async function readSide(file, withNote) {
  let info;
  try {
    info = await stat(file);
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
  try {
    const raw = JSON.parse(await readFile(file, "utf8"));
    const draft = cleanDraft(raw);
    if (withNote) draft.note = text(raw, "note");
    return { mtime: info.mtimeMs, draft };
  } catch (err) {
    // A broken file is shown as an error, never overwritten or deleted.
    return { mtime: info.mtimeMs, error: err.message };
  }
}

export async function listDrafts(projectDir) {
  const dir = join(projectDir, "Drafts");
  let files;
  try {
    files = await readdir(dir);
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
  const names = new Set();
  for (const file of files) {
    for (const ext of [HUMAN_EXT, CLAUDE_EXT]) {
      if (file.endsWith(ext) && isDraftName(file.slice(0, -ext.length))) names.add(file.slice(0, -ext.length));
    }
  }
  return Promise.all([...names].sort().map(async (name) => ({
    name,
    human: await readSide(join(dir, name + HUMAN_EXT), false),
    claude: await readSide(join(dir, name + CLAUDE_EXT), true),
  })));
}

/**
 * Write the user's side. `baseMtime` is the mtime the editor loaded (null for a new draft); if the file changed
 * since, nothing is written and ConflictError is thrown. Returns the new mtime.
 */
export async function saveHuman(projectDir, name, data, baseMtime) {
  if (!isDraftName(name)) throw new ValidationError("name: letters, digits, - and _ only (1-64 chars)");
  const draft = cleanDraft(data);
  const dir = join(projectDir, "Drafts");
  const file = join(dir, name + HUMAN_EXT);
  const current = await stat(file).then((s) => s.mtimeMs, (err) => {
    if (err.code === "ENOENT") return null;
    throw err;
  });
  if (baseMtime === null || baseMtime === undefined) {
    if (current !== null) throw new ConflictError("A draft with this name already exists.");
  } else if (current === null) {
    throw new ConflictError("The draft file was deleted.");
  } else if (current !== baseMtime) {
    throw new ConflictError("The draft file changed since you opened it.");
  }
  await mkdir(dir, { recursive: true });
  // Write-then-rename so Claude never reads a half-written file.
  const tmp = `${file}.tmp`;
  await writeFile(tmp, JSON.stringify(draft, null, 2) + "\n", "utf8");
  await rename(tmp, file);
  return (await stat(file)).mtimeMs;
}

/**
 * The user's Suno voices, as cached by Claude in Drafts/voices.json after a voices-list call:
 * {"updated_at": "...", "voices": [{"id": "", "name": ""}]}. The app cannot call Suno itself, so this file is the
 * only source. Entries with a malformed id are dropped; a missing file means "not fetched yet".
 */
export async function readVoices(projectDir) {
  let raw;
  try {
    raw = JSON.parse(await readFile(join(projectDir, "Drafts", VOICES_FILE), "utf8"));
  } catch (err) {
    if (err.code === "ENOENT") return { fetched: false, voices: [] };
    return { fetched: false, voices: [], error: err.message };
  }
  const list = Array.isArray(raw?.voices) ? raw.voices : [];
  const voices = list
    .filter((v) => v && typeof v.id === "string" && VOICE_ID.test(v.id))
    .slice(0, VOICES_MAX)
    .map((v) => ({ id: v.id, name: typeof v.name === "string" ? v.name.slice(0, LABEL_MAX) : v.id }));
  return { fetched: true, updatedAt: typeof raw.updated_at === "string" ? raw.updated_at.slice(0, 40) : null, voices };
}
