/**
 * @system cli-session-capture
 * @status handwritten
 * @edit edit directly
 *
 * Per-CLI session-id capture adapters. Each adapter watches a CLI-specific
 * location (JSONL file, SQLite database, rollout directory) for a freshly
 * launched process to announce its session-id.
 *
 * Adding a new adapter:
 *   1. Implement the CaptureAdapter function for the new strategy.
 *   2. Register it in ADAPTERS below.
 *   3. Update the session_picker_option's resume.capture config value.
 */

import { Database } from "bun:sqlite";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

// Structural shape of a readdir({ withFileTypes: true }) entry — the walker
// only uses name + isDirectory, so no node:fs type import is needed.
type DirEntry = { name: string; isDirectory(): boolean };

export interface CaptureContext {
	tmuxSession: string;
	windowName: string;
	tabId?: string;
	cwd: string;
	capturePattern?: string;
	timeoutMs: number;
}

export type CaptureAdapter = (ctx: CaptureContext) => Promise<string | null>;

export type OnCaptured = (
	ctx: CaptureContext,
	sessionId: string,
) => Promise<void>;

const claudeJsonlWatch: CaptureAdapter = async (ctx) => {
	const encoded = ctx.cwd.replace(/[/]/g, "-");
	const dir = join(homedir(), ".claude", "projects", encoded);

	const snapshot = async (): Promise<Map<string, number>> => {
		const m = new Map<string, number>();
		try {
			if (!(await Bun.file(dir).exists())) return m;
			for (const name of (await readdir(dir))) {
				if (!name.endsWith(".jsonl")) continue;
				try {
					m.set(name, (await Bun.file(join(dir, name)).stat()).mtimeMs);
				} catch {
					// transient — skip
				}
			}
		} catch {
			// dir vanished between exists check and readdir
		}
		return m;
	};

	const before = await snapshot();
	const deadline = Date.now() + ctx.timeoutMs;

	const extractId = async (name: string): Promise<string | null> => {
		try {
			const content = await Bun.file(join(dir, name)).text();
			const firstLine = content.split("\n")[0];
			if (firstLine) {
				const msg = JSON.parse(firstLine) as {
					sessionId?: string;
					session_id?: string;
				};
				const id = msg.sessionId ?? msg.session_id;
				if (id) return id;
			}
		} catch {
			// fall through to filename fallback
		}
		const base = name.replace(/\.jsonl$/, "");
		return base || null;
	};

	while (Date.now() < deadline) {
		await Bun.sleep(500);
		const after = await snapshot();
		for (const [name] of after) {
			if (!before.has(name)) {
				const id = await extractId(name);
				if (id) return id;
			}
		}
		for (const [name, mtime] of after) {
			const prior = before.get(name);
			if (prior !== undefined && mtime > prior) {
				const id = await extractId(name);
				if (id) return id;
			}
		}
	}
	return null;
};

const opencodeSqliteWatch: CaptureAdapter = async (ctx) => {
	const dbPath = join(homedir(), ".local", "share", "opencode", "opencode.db");
	if (!(await Bun.file(dbPath).exists())) return null;

	const querySessions = (): Set<string> => {
		try {
			const db = new Database(dbPath, { readonly: true });
			const rows = db
				.query("SELECT id FROM session ORDER BY time_created DESC LIMIT 50;")
				.all() as { id: string }[];
			db.close();
			return new Set(rows.map((r) => r.id).filter(Boolean));
		} catch (error) {
			process.stderr.write(`[cli-session-capture] opencode sqlite read failed — empty session set: ${String(error)}
`);
			return new Set();
		}
	};

	const before = querySessions();
	const deadline = Date.now() + ctx.timeoutMs;

	while (Date.now() < deadline) {
		await Bun.sleep(700);
		const after = querySessions();
		for (const id of after) {
			if (!before.has(id)) return id;
		}
	}
	return null;
};

const codexRolloutWatch: CaptureAdapter = async (ctx) => {
	const root = join(homedir(), ".codex", "sessions");
	if (!(await Bun.file(root).exists())) return null;

	const candidates = async (): Promise<string[]> => {
		const dates: Date[] = [new Date(), new Date(Date.now() - 86_400_000)];
		const dirs: string[] = [];
		for (const d of dates) {
			const yyyy = String(d.getFullYear());
			const mm = String(d.getMonth() + 1).padStart(2, "0");
			const dd = String(d.getDate()).padStart(2, "0");
			const p = join(root, yyyy, mm, dd);
			if (await Bun.file(p).exists()) dirs.push(p);
		}
		return dirs;
	};

	const snapshot = async (): Promise<Set<string>> => {
		const s = new Set<string>();
		for (const dir of await candidates()) {
			try {
				for (const name of (await readdir(dir))) {
					if (name.startsWith("rollout-") && name.endsWith(".jsonl")) {
						s.add(join(dir, name));
					}
				}
			} catch {
				// ignore
			}
		}
		return s;
	};

	const before = await snapshot();
	const deadline = Date.now() + ctx.timeoutMs;
	const uuidRe =
		/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

	while (Date.now() < deadline) {
		await Bun.sleep(700);
		const after = await snapshot();
		for (const path of after) {
			if (before.has(path)) continue;
			const m = uuidRe.exec(path);
			if (m?.[1]) return m[1];
		}
	}
	return null;
};

const piJsonlWatch: CaptureAdapter = async (ctx) => {
	// Pi stores sessions as ~/.pi/agent/sessions/<encoded-cwd>/<timestamp>_<uuid>.jsonl
	// (header line: {"type":"session","version":3,"id":"<uuid>","cwd":"<cwd>",...}).
	// Pi mints its own session uuid (pi --session <id> only OPENS an existing one,
	// so this CLI is cli_generates_own_id → capture, not seed). The <encoded-cwd> dir
	// name is not relied on here — instead we scan the sessions root recursively and
	// match a NEW .jsonl by its header `cwd` == ctx.cwd, which is robust to the exact
	// dir-encoding and to sessions rooted at any ancestor path.
	const root = join(homedir(), ".pi", "agent", "sessions");

	const listFiles = async (): Promise<Map<string, number>> => {
		const m = new Map<string, number>();
		try {
			const walk = async (dir: string): Promise<void> => {
				let entries: DirEntry[];
				try {
					entries = await readdir(dir, { withFileTypes: true });
				} catch {
					return;
				}
				for (const entry of entries) {
					const p = join(dir, entry.name);
					if (entry.isDirectory()) {
						await walk(p);
					} else if (entry.name.endsWith(".jsonl")) {
						try {
							m.set(p, (await Bun.file(p).stat()).mtimeMs);
						} catch {
							// transient — skip
						}
					}
				}
			};
			// No Bun.file(root).exists() pre-check: Bun.file models a FILE and
			// .exists() is FALSE for a directory, so that guard skipped the walk
			// unconditionally and pi capture could never have succeeded. walk()'s own
			// readdir catch already handles a missing root. Found 2026-08-01 while
			// writing another adapter, which had copied the same guard.
			await walk(root);
		} catch {
			// root vanished — nothing to watch
		}
		return m;
	};

	const before = await listFiles();
	const deadline = Date.now() + ctx.timeoutMs;

	const extractId = async (path: string): Promise<string | null> => {
		try {
			const firstLine = (await Bun.file(path).text()).split("\n")[0];
			if (!firstLine) return null;
			const hdr = JSON.parse(firstLine) as { id?: string; cwd?: string };
			if (hdr.cwd !== ctx.cwd) return null; // a different project's session
			return hdr.id ?? null;
		} catch {
			return null;
		}
	};

	while (Date.now() < deadline) {
		await Bun.sleep(500);
		const after = await listFiles();
		for (const [path] of after) {
			if (!before.has(path)) {
				const id = await extractId(path);
				if (id) return id;
			}
		}
	}
	return null;
};

const ADAPTERS: Record<string, CaptureAdapter> = {
	"claude-jsonl-watch": claudeJsonlWatch,
	"opencode-sqlite-watch": opencodeSqliteWatch,
	"codex-rollout-watch": codexRolloutWatch,
	"pi-jsonl-watch": piJsonlWatch,
};

export function getAdapter(slug: string): CaptureAdapter | undefined {
	return ADAPTERS[slug];
}

export function listAdapterSlugs(): string[] {
	return Object.keys(ADAPTERS);
}

export async function runCapture(
	captureSlug: string,
	ctx: CaptureContext,
	onCaptured: OnCaptured,
): Promise<void> {
	const adapter = ADAPTERS[captureSlug];
	if (!adapter) return;
	try {
		const id = await adapter(ctx);
		if (id) {
			await onCaptured(ctx, id);
		}
	} catch {
		// best-effort
	}
}
