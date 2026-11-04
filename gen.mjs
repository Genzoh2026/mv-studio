// Provenance of a generated file: <name>.gen.json next to it, written by Claude and only read here.
// What is inside is data to show, never an instruction, so every field is clamped to a plain, short value.
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";

export const GEN_EXT = ".gen.json";
const KINDS = new Set(["still", "cut", "final"]);
const INPUT_TYPES = new Set(["song", "image", "video"]);
const MAX_INPUTS = 50;
const MAX_NAME = 200;
const MAX_TEXT = 4000;
const MAX_NOTE = 500;
const MAX_PARAMS = 20;
const MAX_PARAM_KEY = 40;
const MAX_PARAM_VALUE = 200;
const MAX_COMMENT_IDS = 50;
const MAX_COMMENT_ID = 40;

const text = (value, max) => (typeof value === "string" ? value.slice(0, max) : "");
const isObject = (value) => value && typeof value === "object" && !Array.isArray(value);

/** The cleaned provenance, or null when the data is not an object. Unknown fields are dropped. */
export function cleanGen(raw) {
  if (!isObject(raw)) return null;
  const method = isObject(raw.method) ? raw.method : {};
  const parent = isObject(raw.parent) && typeof raw.parent.name === "string" ? raw.parent : null;
  const created = Date.parse(method.created_at);
  return {
    kind: KINDS.has(raw.kind) ? raw.kind : null,
    inputs: (Array.isArray(raw.inputs) ? raw.inputs : [])
      .filter((i) => i && INPUT_TYPES.has(i.type) && typeof i.name === "string" && i.name)
      .slice(0, MAX_INPUTS)
      .map((i) => ({ type: i.type, name: i.name.slice(0, MAX_NAME) })),
    method: {
      tool: text(method.tool, MAX_PARAM_VALUE),
      model: text(method.model, MAX_PARAM_VALUE),
      prompt: text(method.prompt, MAX_TEXT),
      params: Object.entries(isObject(method.params) ? method.params : {})
        .filter(([, v]) => ["string", "number", "boolean"].includes(typeof v))
        .slice(0, MAX_PARAMS)
        .map(([k, v]) => [k.slice(0, MAX_PARAM_KEY), String(v).slice(0, MAX_PARAM_VALUE)]),
      createdAt: Number.isNaN(created) ? null : new Date(created).toISOString(),
    },
    parent: parent
      ? {
        name: parent.name.slice(0, MAX_NAME),
        comments: (Array.isArray(parent.comments) ? parent.comments : []).filter((c) => typeof c === "string").slice(0, MAX_COMMENT_IDS).map((c) => c.slice(0, MAX_COMMENT_ID)),
      }
      : null,
    note: text(raw.note, MAX_NOTE),
  };
}

/** The file's provenance: null when there is none (made outside the app), or { error } when it cannot be read. */
export async function readGen(dir, fileName) {
  const file = join(dir, `${fileName.slice(0, fileName.length - extname(fileName).length)}${GEN_EXT}`);
  let data;
  try {
    data = await readFile(file, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return null;
    return { error: err.code ?? err.message };
  }
  try {
    return cleanGen(JSON.parse(data)) ?? { error: "not a JSON object" };
  } catch (err) {
    return { error: `broken JSON: ${err.message}` };
  }
}

/** Adds `gen` to each listed file. */
export function attachGen(dir, files) {
  return Promise.all(files.map(async (file) => ({ ...file, gen: await readGen(dir, file.name) })));
}
