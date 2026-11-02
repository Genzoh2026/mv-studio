// One long-lived terminal session (a Claude Code process) per project.
// Sessions outlive browser tabs and project switches, so switching never kills running work.
import pty from "@lydell/node-pty";

export const MAX_SESSIONS = 5;
const BUFFER_LIMIT = 300_000;
const RESIZE_PREFIX = "\u0000resize:";
const DEFAULT_COLS = 100;
const DEFAULT_ROWS = 30;

export class SessionLimitError extends Error {}

/**
 * @param {{command: string, args: string[], env: () => Record<string, string>}} launch how to start the CLI
 */
export function createSessions({ command, args, env }) {
  /** @type {Map<string, {term: import("@lydell/node-pty").IPty, buffer: string, clients: Set<import("ws").WebSocket>}>} */
  const sessions = new Map();

  function open(name, cwd) {
    const existing = sessions.get(name);
    if (existing) return existing;
    if (sessions.size >= MAX_SESSIONS) {
      throw new SessionLimitError(`Up to ${MAX_SESSIONS} sessions can run at once. End one from the library first.`);
    }
    const term = pty.spawn(command, args, { name: "xterm-256color", cols: DEFAULT_COLS, rows: DEFAULT_ROWS, cwd, env: env() });
    const session = { term, buffer: "", clients: new Set() };
    term.onData((data) => {
      // Kept so a reattaching tab can show what happened while it was away.
      session.buffer = (session.buffer + data).slice(-BUFFER_LIMIT);
      for (const client of session.clients) if (client.readyState === 1) client.send(data);
    });
    term.onExit(() => {
      if (sessions.get(name) === session) sessions.delete(name);
      for (const client of session.clients) client.close(1000, "session ended");
    });
    sessions.set(name, session);
    return session;
  }

  /** Connect a browser socket to the project's session, starting it if needed. Throws SessionLimitError. */
  function attach(name, cwd, ws) {
    const session = open(name, cwd);
    if (session.buffer) ws.send(session.buffer);
    session.clients.add(ws);
    ws.on("message", (message) => {
      const text = message.toString();
      if (text.startsWith(RESIZE_PREFIX)) {
        const [cols, rows] = text.slice(RESIZE_PREFIX.length).split(",").map(Number);
        if (cols > 0 && rows > 0) session.term.resize(cols, rows);
      } else session.term.write(text);
    });
    // Closing the tab only detaches; the process keeps running.
    ws.on("close", () => session.clients.delete(ws));
  }

  return {
    attach,
    running: () => [...sessions.keys()],
    end(name) {
      const session = sessions.get(name);
      if (!session) return false;
      session.term.kill();
      return true;
    },
    endAll() {
      for (const session of sessions.values()) session.term.kill();
    },
  };
}
