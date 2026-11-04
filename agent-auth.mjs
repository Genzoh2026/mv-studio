// How the app lets the Claude it started call back into it (separation, beat analysis, tool setup) without opening those
// actions to anyone else on this computer: each project's Claude is handed a token that works for that project only.
// The token is derived from a secret that exists only in this server process, so it stops working when the app restarts.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export function createAgentAuth(secret = randomBytes(32)) {
  const tokenFor = (project) => createHmac("sha256", secret).update(`mv-studio:${project}`).digest("hex");
  return {
    /** The token to give to the Claude session of `project`. */
    tokenFor,
    /** True only for the token made for exactly this project. */
    verify(project, token) {
      if (typeof project !== "string" || !project || typeof token !== "string") return false;
      const expected = Buffer.from(tokenFor(project));
      const given = Buffer.from(token);
      return given.length === expected.length && timingSafeEqual(given, expected);
    },
  };
}
