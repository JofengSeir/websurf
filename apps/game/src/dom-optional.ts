/**
 * 可选 DOM 取用：页面结构与代码不一致时**不再静默降级**（T-202）。
 *
 * 为什么单列一个模块：`apps/game/src/app.ts` 是入口模块（顶层有副作用、探针无法 import），
 * 而「缺失时打可读告警」这条行为需要能被探针直接验证，故把纯函数抽到这里。
 *
 * 调用面：`apps/game/src/app.ts` 的 `dom` 对象（`#bspFile` / `#spawnSelect` /
 * `#respawnBtn`）与 `bindInput` 里的 `#loadMapBtn`。
 */

/** 取可选控件；缺失时打一条 `console.warn`（点名 id）并返回 `null`。 */
export function optDom<T extends HTMLElement>(id: string): T | null {
	const el = document.getElementById(id) as T | null;
	if (!el) console.warn(`[app] 页面缺少可选控件 #${id}（对应入口不可用）`);
	return el;
}
