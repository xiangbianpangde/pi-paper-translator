import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { loadUserConfig, resolveBackendDir, resolveLibraryRoot, userConfigPath } from "../extensions/lib/pdf2zh/user-config.ts";

const envKeys = ["PI_PAPER_TRANSLATOR_CONFIG", "PDF2ZH_PROJECT_DIR", "PI_PAPER_TRANSLATOR_LIBRARY_ROOT"] as const;
const originalEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
let scratch: string;

before(async () => {
	scratch = await mkdtemp(join(tmpdir(), "pi-paper-translator-config-"));
	process.env.PI_PAPER_TRANSLATOR_CONFIG = join(scratch, "config.json");
	delete process.env.PDF2ZH_PROJECT_DIR;
	delete process.env.PI_PAPER_TRANSLATOR_LIBRARY_ROOT;
});

after(async () => {
	await rm(scratch, { recursive: true, force: true });
	for (const key of envKeys) {
		const value = originalEnv[key];
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
});

describe("external user configuration", () => {
	it("loads backend and library paths from a config outside the package", async () => {
		await writeFile(userConfigPath(), JSON.stringify({ backendDir: "/data/pdf2zh", libraryRoot: "/vault/papers" }));
		assert.deepEqual(loadUserConfig(), { backendDir: "/data/pdf2zh", libraryRoot: "/vault/papers" });
		assert.equal(resolveBackendDir(), "/data/pdf2zh");
		assert.equal(resolveLibraryRoot(), "/vault/papers");
	});

	it("lets environment overrides take precedence", async () => {
		await writeFile(userConfigPath(), JSON.stringify({ backendDir: "/configured/backend", libraryRoot: "/configured/library" }));
		process.env.PDF2ZH_PROJECT_DIR = "/env/backend";
		process.env.PI_PAPER_TRANSLATOR_LIBRARY_ROOT = "/env/library";
		assert.equal(resolveBackendDir(), "/env/backend");
		assert.equal(resolveLibraryRoot(), "/env/library");
	});

	it("rejects malformed config instead of silently using a different backend", async () => {
		await writeFile(userConfigPath(), "not-json");
		assert.throws(() => loadUserConfig(), /无法读取 Pi Paper Translator 配置/);
	});
});
