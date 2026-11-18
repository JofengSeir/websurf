#!/usr/bin/env node
/**
 * config-sync 段契约门禁（P5 B5，2026-11-18）。
 *
 * 目的：`createConfigSync` 的段清单/顺序是两端行为契约（debug 启动 5 段、载图 7 段；
 * game 4 段），下沉后没有类型系统能约束「数组内容与顺序」——这里做源码级静态断言。
 *
 * 提取规则（有意保持简单、可在 CI 无依赖运行）：
 * - 只读源码文本，不执行 TS。
 * - 目标：`apps/debug/src/app.ts` 的 `CONFIG_PREFS_SECTIONS` / `CONFIG_FULL_SECTIONS`，
 *   `apps/game/src/app.ts` 的 `CONFIG_SYNC_SECTIONS`。
 * - 形如 `const NAME... = [ 'a', 'b', ... ]`（可跨行），取数组内引号字符串，保序。
 * - 另断言调用骨架存在：debug `syncConfig({ sections: CONFIG_PREFS_SECTIONS, render: false })`、
 *   两端 `createConfigSync` 且 `sections: CONFIG_FULL_SECTIONS` / `CONFIG_SYNC_SECTIONS`。
 *
 * 用法：node src/scripts/check-config-sync-contract.mjs [--debug <file>] [--game <file>]
 *   --debug/--game 可覆盖源码路径（用于反控：改一份副本换顺序应 FAIL）。
 * 退出码：0=全部符合；1=契约被破坏；2=参数/文件错误。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
const DEFAULTS = {
	debug: path.join(ROOT, 'apps/debug/src/app.ts'),
	game: path.join(ROOT, 'apps/game/src/app.ts'),
};

const EXPECTED = {
	debugPrefs: ['input', 'hud', 'debug', 'lod', 'player'],
	debugFull: ['physics', 'player', 'lod', 'lighting', 'input', 'hud', 'debug'],
	gameSync: ['physics', 'input', 'player', 'hud'],
};

/** @returns {{ file: string, text: string } | null} */
function parseArgs(argv) {
	const files = { debug: DEFAULTS.debug, game: DEFAULTS.game };
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === '--debug' || arg === '--game') {
			const value = argv[++i];
			if (!value) {
				console.error(`[config-sync-contract] ${arg} 需要一个文件路径`);
				return null;
			}
			files[arg.slice(2)] = path.resolve(ROOT, value);
			continue;
		}
		console.error(`[config-sync-contract] 未知参数：${arg}`);
		return null;
	}
	return files;
}

function read(file, label) {
	try {
		return readFileSync(file, 'utf8');
	} catch (error) {
		console.error(`[config-sync-contract] 读取 ${label} 失败（${file}）：${String(error)}`);
		return null;
	}
}

/** 从源码提取 `const NAME ... = [ ... ]` 的引号字符串（保序）。找不到返回 null。 */
function extractArray(text, name) {
	const declaration = new RegExp(`const\\s+${name}\\s*[^=]*=\\s*\\[([\\s\\S]*?)\\]`).exec(text);
	if (!declaration) return null;
	const values = [];
	for (const match of declaration[1].matchAll(/(['"])([^'"]*)\1/g)) values.push(match[2]);
	return values;
}

let passed = 0;
function check(label, actual, expected) {
	if (!actual) {
		console.error(`[config-sync-contract] FAIL ${label}：未找到段清单声明`);
		return false;
	}
	if (actual.length !== expected.length || actual.some((value, i) => value !== expected[i])) {
		console.error(
			`[config-sync-contract] FAIL ${label}：期望 [${expected.join(',')}]，实际 [${actual.join(',')}]`,
		);
		return false;
	}
	if (new Set(actual).size !== actual.length) {
		console.error(`[config-sync-contract] FAIL ${label}：段清单有重复项 [${actual.join(',')}]`);
		return false;
	}
	passed++;
	console.log(`[config-sync-contract] OK   ${label} = [${actual.join(',')}]`);
	return true;
}

function checkCall(label, pattern, text) {
	if (!pattern.test(text)) {
		console.error(`[config-sync-contract] FAIL ${label}：调用骨架不符合期望（${pattern}）`);
		return false;
	}
	passed++;
	console.log(`[config-sync-contract] OK   ${label}`);
	return true;
}

const files = parseArgs(process.argv.slice(2));
if (!files) process.exit(2);
const debugText = read(files.debug, 'debug app.ts');
const gameText = read(files.game, 'game app.ts');
if (debugText === null || gameText === null) process.exit(2);

let ok = true;
ok = check('debug CONFIG_PREFS_SECTIONS（启动 5 段）', extractArray(debugText, 'CONFIG_PREFS_SECTIONS'), EXPECTED.debugPrefs) && ok;
ok = check('debug CONFIG_FULL_SECTIONS（载图 7 段）', extractArray(debugText, 'CONFIG_FULL_SECTIONS'), EXPECTED.debugFull) && ok;
ok = check('game CONFIG_SYNC_SECTIONS（4 段）', extractArray(gameText, 'CONFIG_SYNC_SECTIONS'), EXPECTED.gameSync) && ok;
ok =
	checkCall(
		'debug 启动同步：syncConfig({ sections: CONFIG_PREFS_SECTIONS, render: false })',
		/syncConfig\(\s*\{\s*sections:\s*CONFIG_PREFS_SECTIONS\s*,\s*render:\s*false\s*\}\s*\)/,
		debugText,
	) && ok;
ok = checkCall('debug createConfigSync + sections: CONFIG_FULL_SECTIONS', /createConfigSync\s*[<(][\s\S]*?sections:\s*CONFIG_FULL_SECTIONS/, debugText) && ok;
ok = checkCall('game createConfigSync + sections: CONFIG_SYNC_SECTIONS', /createConfigSync\s*[<(][\s\S]*?sections:\s*CONFIG_SYNC_SECTIONS/, gameText) && ok;

if (!ok) {
	console.error(`[config-sync-contract] FAILED：${passed}/6 项通过`);
	process.exit(1);
}
console.log(`[config-sync-contract] OK：${passed}/6 项断言通过（两端段清单/顺序与调用骨架一致）`);
