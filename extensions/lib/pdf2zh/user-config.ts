import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

export interface UserConfig {
	backendDir?: string;
	libraryRoot?: string;
}

export function userConfigPath(): string {
	const explicit = process.env.PI_PAPER_TRANSLATOR_CONFIG?.trim();
	if (explicit) return expandPath(explicit);
	const configHome = process.env.XDG_CONFIG_HOME?.trim() || join(homedir(), ".config");
	return join(configHome, "pi-paper-translator", "config.json");
}

export function loadUserConfig(): UserConfig {
	const path = userConfigPath();
	if (!existsSync(path)) return {};
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		throw new Error(`无法读取 Pi Paper Translator 配置 ${path}: ${(error as Error).message}`);
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error(`Pi Paper Translator 配置必须是 JSON 对象：${path}`);
	}
	const value = parsed as Record<string, unknown>;
	return {
		backendDir: asPath(value.backendDir),
		libraryRoot: asPath(value.libraryRoot),
	};
}

/** PDF2ZH_PROJECT_DIR remains supported for existing users and test harnesses. */
export function resolveBackendDir(): string {
	const fromEnv = process.env.PDF2ZH_PROJECT_DIR?.trim();
	if (fromEnv) return expandPath(fromEnv);
	const configured = loadUserConfig().backendDir;
	if (configured) return expandPath(configured);
	return join(homedir(), "Projects", "pdf2zh");
}

export function resolveLibraryRoot(): string | undefined {
	const fromEnv = process.env.PI_PAPER_TRANSLATOR_LIBRARY_ROOT?.trim();
	if (fromEnv) return expandPath(fromEnv);
	const configured = loadUserConfig().libraryRoot;
	return configured ? expandPath(configured) : undefined;
}

function asPath(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function expandPath(value: string): string {
	const expanded = value === "~" ? homedir() : value.startsWith("~/") ? join(homedir(), value.slice(2)) : value;
	return isAbsolute(expanded) ? resolve(expanded) : resolve(process.cwd(), expanded);
}
