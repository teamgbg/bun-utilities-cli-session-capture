// @system codegen
// @status generated
// @edit change the suite in the owned-suites band, then re-run codegen. Hand-edits are overwritten.
//
// This suite's assertions are OWNED by the codegen band: the band module
// carries them verbatim, this file is the emission, and hand edits here are
// overwritten on the next run. The rationale each assertion carries moved
// with it into the band.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { getAdapter, listAdapterSlugs } from "./cli-session-capture.ts";

const ROOT = join(homedir(), ".pi", "agent", "sessions");
const MADE: string[] = [];

async function writeSession(id: string, cwd: string): Promise<void> {
	const p = join(ROOT, `${id}.jsonl`);
	await Bun.file(p).write(`${JSON.stringify({ id, cwd })}\n`);
	MADE.push(p);
}

beforeEach(async () => {
	await mkdir(ROOT, { recursive: true });
});

afterEach(async () => {
	for (const p of MADE.splice(0)) await rm(p, { force: true });
});

describe("adapter registry", () => {
	test("registers the four capture adapters under their slugs", () => {
		expect(listAdapterSlugs().sort()).toEqual([
			"claude-jsonl-watch",
			"codex-rollout-watch",
			"opencode-sqlite-watch",
			"pi-jsonl-watch",
		]);
	});

	test("returns undefined for an unknown slug", () => {
		expect(getAdapter("invented-watch")).toBeUndefined();
	});
});

describe("pi-jsonl-watch", () => {
	test("returns the id of a session file that appears after the watch starts", async () => {
		const adapter = getAdapter("pi-jsonl-watch")!;
		const id = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
		const pending = adapter({
			tmuxSession: "joe",
			windowName: "Test",
			tabId: "tab-1",
			cwd: join(homedir(), "workspace"),
			timeoutMs: 3_000,
		} as Parameters<typeof adapter>[0]);
		// Written AFTER the adapter snapshots the directory — a pre-existing file
		// must not be adopted, which is what the snapshot is for.
		await Bun.sleep(700);
		await writeSession(id, join(homedir(), "workspace"));
		expect(await pending).toBe(id);
	}, 10_000);

	test("ignores a session file for a different cwd", async () => {
		const adapter = getAdapter("pi-jsonl-watch")!;
		await writeSession("11111111-2222-3333-4444-555555555555", "/elsewhere");
		const id = await adapter({
			tmuxSession: "joe",
			windowName: "Test",
			tabId: "tab-1",
			cwd: join(homedir(), "workspace"),
			timeoutMs: 1_500,
		} as Parameters<typeof adapter>[0]);
		expect(id).toBeNull();
	}, 10_000);
});
