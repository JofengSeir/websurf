/**
 * 三端 app 的 config 段同步（P5，2026-11-18）。
 *
 * 背景：debug/game 各有一份「全量 config → 逐段下发 + 主线程副作用」的代码，顺序与调用骨架相同，
 * 但每段 payload 形状、副作用位置、预测镜像方式端特有（见 `.tmp/config-sync/PLAN.md` §A3）。
 * 本模块只统一下沉「按顺序遍历 → 合并 → 渲染副作用 → 下发 → 段后钩子」这条骨架；
 * payload 形状与副作用实现仍由各端适配器提供，不强行统一段 schema。
 *
 * 时序约定（重要）：`syncConfig()` 的调用时机由调用方负责，必须在世界建好之后
 * （`worker-dispatch` 在 `phys.current == null` 时会丢弃 config 消息）。构造实例本身没有时序要求，
 * 但建议在 AppRuntime 已就绪（bridge/renderer 引用可用）之后构造，本模块不另设 init()。
 *
 * 注意：本模块不接管段顺序语义——顺序只在「世界未建好时」可能影响结果；等价判据见 PLAN §A4。
 */

/** 单段 config 形状：纯对象（各端 schema 不同，不做公共类型抽取）。 */
export type ConfigSection = Record<string, unknown>;

/** 主线程副作用适配器：按段名分发（缺省 = 该段无副作用）。 */
export type ConfigRenderAdapter<C extends object> = Partial<Record<keyof C, (patch: ConfigSection) => void>>;

/** 段 → 对象读取（两端 RuntimeConfig 是 interface、没有 index signature，故统一在此收口）。 */
function sectionOf<C extends object>(config: C, section: keyof C): ConfigSection {
	return config[section] as unknown as ConfigSection;
}

export interface ConfigSyncOptions<C extends object, R = unknown, B = unknown> {
	/** 两端各自的 RuntimeConfig 实例。 */
	config: C;
	/** 需要同步的段名与顺序（每端各自枚举）。 */
	sections: readonly (keyof C)[];
	/** 渲染器/桥接实例，仅透传给适配器，本模块不直接使用。 */
	renderer?: R;
	bridge?: B;
	/** 本地合并策略，缺省 `Object.assign(config[section], patch)`。 */
	applyPatch?: (section: keyof C, patch: ConfigSection) => void;
	/** 段 → Worker 下行（debug 直发 patch；game 在 bridge 内展开全量参数）。 */
	send: (section: keyof C, patch: ConfigSection) => void;
	/** 下行前改写/丢弃（返回 null 表示该段不发）。 */
	transform?: (section: keyof C, patch: ConfigSection) => ConfigSection | null;
	/** 主线程副作用（debug 的 applyConfigPatch；game 的 setter/面板回调）。 */
	render?: ConfigRenderAdapter<C>;
	/** 段后钩子（持久化/日志挂点）。 */
	afterSection?: (section: keyof C, patch: ConfigSection) => void;
}

/** 全量同步的可选覆盖（debug 启动只发 5 段、且不跑 renderer 副作用）。 */
export interface SyncConfigOptions<C extends object> {
	sections?: readonly (keyof C)[];
	/** 是否执行 renderer 副作用；缺省 true。 */
	render?: boolean;
}

export interface ConfigSync<C extends object> {
	/** 全量同步：按 sections 顺序逐段 apply → render → send。 */
	syncConfig(options?: SyncConfigOptions<C>): void;
	/** 单段增量：本地合并 → render → send。 */
	applyPatch(section: keyof C, patch: ConfigSection): void;
	/** 等价断言用：sections 的深拷贝快照。 */
	snapshot(): Record<string, ConfigSection>;
}

function deepCopy<T>(value: T): T {
	return JSON.parse(JSON.stringify(value)) as T;
}

export function createConfigSync<C extends object, R = unknown, B = unknown>(
	options: ConfigSyncOptions<C, R, B>,
): ConfigSync<C> {
	const { config, sections } = options;

	const emit = (section: keyof C, patch: ConfigSection, withRender: boolean): void => {
		// transform 返回 null 表示「该段不发」——必须先判 null 再兜底，不能用 `?? patch`
		// （`null ?? patch` 会把丢弃意图吞掉）。
		const transformed = options.transform ? options.transform(section, patch) : patch;
		if (transformed === null) return;
		if (withRender) options.render?.[section]?.(transformed);
		options.send(section, transformed);
		options.afterSection?.(section, transformed);
	};

	const merge = (section: keyof C, patch: ConfigSection): void => {
		if (options.applyPatch) {
			options.applyPatch(section, patch);
			return;
		}
		Object.assign(sectionOf(config, section), patch);
	};

	return {
		syncConfig(syncOptions?: SyncConfigOptions<C>): void {
			const list = syncOptions?.sections ?? sections;
			const withRender = syncOptions?.render !== false;
			for (const section of list) {
				emit(section, { ...sectionOf(config, section) }, withRender);
			}
		},
		applyPatch(section: keyof C, patch: ConfigSection): void {
			merge(section, patch);
			emit(section, patch, true);
		},
		snapshot(): Record<string, ConfigSection> {
			const out: Record<string, ConfigSection> = {};
			for (const section of sections) {
				out[String(section)] = deepCopy(sectionOf(config, section));
			}
			return out;
		},
	};
}
