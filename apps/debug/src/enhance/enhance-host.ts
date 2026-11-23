/**
 * debug 端的「增强插件宿主」：可选能力的总开关 + 生命周期管理。
 *
 * 默认零成本的具体做法（owner 2026-11-22：增强型可选插件、尽可能不影响之前的性能）：
 *   - 构造时只读一次 localStorage / URL（便宜），不 import 任何插件模块；
 *   - 没有任何插件装载时，通过 `hooks.setEventSink(null)` 让 `RendererMain.onEntityEvent`
 *     保持 `null`——实体事件派发处的可选调用直接短路，不产生任何函数调用与分配；
 *   - 插件模块只在被启用时才动态 `import`（`PLUGIN_FACTORIES` 里逐个 `await import`）；
 *   - 卸载插件 = `dispose()` + sink 置空，无定时器、无每帧回调。
 *
 * 开关通道（三处，均不写入 `RuntimeConfig`、不下发 Worker）：
 *   1. 面板「增强插件（实验）」复选框；
 *   2. `localStorage[ENHANCE_STORAGE_KEY]`（刷新后保持）；
 *   3. 控制台 `__vbspEnhance.enable('runtime-teleport')` / URL `?enhance=...`（临时）。
 */
import {
  ENHANCE_FLAGS,
  readEnabledEnhanceIds,
  writeEnabledEnhanceIds,
} from '../../../../src/ts-shared/enhance/flags.js';
import type { EntityEvent } from '../../../../src/ts-shared/entity/types.js';
import type {
  EnhancePlugin,
  EnhancePluginFactory,
  EnhanceRuntime,
  EnhanceSceneContext,
} from '../../../../src/ts-shared/enhance/plugin.js';

/**
 * 插件装载表：键 = `ENHANCE_FLAGS` 的 id，值 = 动态 import 工厂。
 * 关闭状态下这里的函数体一次都不会执行（不产生模块加载）。
 */
const PLUGIN_FACTORIES: Readonly<Record<string, EnhancePluginFactory>> = {
  'runtime-teleport': async (runtime) => {
    const mod = await import('./plugins/runtime-teleport.js');
    return mod.createRuntimeTeleportPlugin(runtime);
  },
  'brush-visibility': async (runtime) => {
    const mod = await import('./plugins/brush-visibility.js');
    return mod.createBrushVisibilityPlugin(runtime);
  },
};

/** 宿主从 app 层拿到的能力（传送必须双端同步，因此由 app 注入而不是宿主自己找 renderer）。 */
export interface EnhanceHostDeps {
  /** 主线程预测物理 + 权威 Worker 同时传送（脚底原点，Y-up，`yawDeg` 单位度）。 */
  teleport(pos: readonly number[], yawDeg?: number): void;
  /** 当前预测物理状态；未就绪返回 null。 */
  getPlayerState(): { posX: number; posY: number; posZ: number; yaw?: number } | null;
  /** 统一日志出口（宿主内部已加 `[enhance]` 前缀）。 */
  log(message: string): void;
}

/** 宿主对 app 的挂接需求。 */
export interface EnhanceHostHooks {
  /**
   * 事件订阅开关：有插件装载时传 handler，没有时传 null。
   * 传 null 是「默认零成本」的关键——调用方（renderer）侧的可选回调直接短路。
   */
  setEventSink(handler: ((event: EntityEvent) => void) | null): void;
  /**
   * 状态可能变化时通知调用方刷新面板行（启停/装载完成/换图/事件派发后）。
   * 可选：没接就只是少一次 UI 刷新，不影响插件语义。
   */
  onStatusChanged?(): void;
}

/** 状态行（面板/控制台诊断）。 */
export interface EnhanceStatus {
  id: string;
  label: string;
  enabled: boolean;
  loaded: boolean;
  status: string;
}

/** 控制台 API（`globalThis.__vbspEnhance`，调试/自动化测试用）。 */
export interface EnhanceConsoleApi {
  list(): EnhanceStatus[];
  enable(id: string): boolean;
  disable(id: string): void;
  status(): string;
}

/** 安全取 localStorage：隐私模式 / 沙箱环境下可能抛错，按「无存储」处理。 */
function safeStorage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

export class EnhanceHost {
  private readonly deps: EnhanceHostDeps;
  private readonly hooks: EnhanceHostHooks;
  private readonly storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null;
  /** 用户选择启用的 id（含尚未装载完成的）。 */
  private readonly enabled = new Set<string>();
  /** 已装载的插件实例。 */
  private readonly plugins = new Map<string, EnhancePlugin>();
  /** 正在动态 import 的插件（防并发重复装载）。 */
  private readonly pending = new Map<string, Promise<EnhancePlugin | null>>();
  /** 当前地图上下文（换图时更新；插件装载晚于换图时用它补 onMapLoad）。 */
  private scene: EnhanceSceneContext | null = null;
  private disposed = false;
  private readonly runtime: EnhanceRuntime;

  constructor(deps: EnhanceHostDeps, hooks: EnhanceHostHooks) {
    this.deps = deps;
    this.hooks = hooks;
    this.storage = safeStorage();
    for (const id of readEnabledEnhanceIds(this.storage, globalThis.location?.search ?? '')) {
      this.enabled.add(id);
    }
    this.runtime = {
      teleport: (pos, yawDeg) => this.deps.teleport(pos, yawDeg),
      getPlayerState: () => this.deps.getPlayerState(),
      log: (message) => this.deps.log(message),
    };
  }

  /** 已启用的 id 列表（含装载中的）。 */
  get enabledIds(): string[] {
    return [...this.enabled];
  }

  isEnabled(id: string): boolean {
    return this.enabled.has(id);
  }

  /** 面板/控制台状态：静态定义 + 启用/装载 + 插件自报状态。 */
  status(): EnhanceStatus[] {
    return ENHANCE_FLAGS.map((flag) => {
      const plugin = this.plugins.get(flag.id);
      return {
        id: flag.id,
        label: flag.label,
        enabled: this.enabled.has(flag.id),
        loaded: plugin !== undefined,
        status: plugin?.statusText?.() ?? '',
      };
    });
  }

  /** 面板/诊断用的一行文本。 */
  describe(): string {
    const enabled = this.status().filter((item) => item.enabled);
    if (enabled.length === 0) return '全部关闭（零成本）';
    return enabled.map((item) => `${item.label}:${item.loaded ? '已装载' : '装载中'}`).join('；');
  }

  /** 单个插件的自报状态（未装载返回空串；面板专属状态行用）。 */
  statusOf(id: string): string {
    return this.plugins.get(id)?.statusText?.() ?? '';
  }

  /** 通知 app 刷新面板状态行；回调抛错不能影响插件主链。 */
  private notifyStatusChanged(): void {
    try {
      this.hooks.onStatusChanged?.();
    } catch (err) {
      this.deps.log(`状态行刷新异常：${String(err)}`);
    }
  }

  /**
   * 换图完成：保存上下文，并让「已启用但还没装载」的插件补装载、已装载的插件重置地图状态。
   * 必须在实体系统装配之后调用（`rendererMain.loadScene()` 返回后）。
   */
  onSceneLoaded(context: EnhanceSceneContext): void {
    if (this.disposed) return;
    this.scene = context;
    this.notifyStatusChanged();
    for (const id of [...this.enabled]) {
      void this.ensureLoaded(id)
        .then((plugin) => {
          plugin?.onMapLoad?.(context);
          this.notifyStatusChanged();
        })
        .catch((err: unknown) => this.deps.log(`插件 ${id} 装载失败：${String(err)}`));
    }
  }

  /** 面板/控制台开关：立即生效并落盘（URL 临时开关不落盘）。 */
  setEnabled(id: string, enabled: boolean): boolean {
    if (this.disposed || !PLUGIN_FACTORIES[id]) return false;
    const changed = this.enabled.has(id) !== enabled;
    if (enabled) this.enabled.add(id);
    else this.enabled.delete(id);
    if (changed) writeEnabledEnhanceIds(this.storage, [...this.enabled]);
    if (enabled) {
      void this.ensureLoaded(id)
        .then((plugin) => {
          if (plugin && this.scene) plugin.onMapLoad?.(this.scene);
          this.notifyStatusChanged();
        })
        .catch((err: unknown) => this.deps.log(`插件 ${id} 装载失败：${String(err)}`));
    } else {
      this.unload(id);
      this.notifyStatusChanged();
    }
    return true;
  }

  /** 安装控制台 API（幂等；自动化测试/临时排查用）。 */
  installConsoleApi(): void {
    const api: EnhanceConsoleApi = {
      list: () => this.status(),
      enable: (id) => this.setEnabled(id, true),
      disable: (id) => this.setEnabled(id, false),
      status: () => this.describe(),
    };
    (globalThis as unknown as { __vbspEnhance?: EnhanceConsoleApi }).__vbspEnhance = api;
  }

  /** 卸载全部插件并摘掉事件订阅。 */
  dispose(): void {
    this.disposed = true;
    for (const id of [...this.plugins.keys()]) this.unload(id);
    this.pending.clear();
    this.scene = null;
    this.hooks.setEventSink(null);
  }

  /** 单个事件的派发入口（只有装载了插件时才会被 renderer 调用）。 */
  private readonly onEntityEvent = (event: EntityEvent): void => {
    // `input` 是最高频的一类（每次 AcceptInput 一条），插件不需要，提前挡掉。
    if (event.kind === 'input') return;
    for (const plugin of this.plugins.values()) plugin.onEvent?.(event);
    // brush 事件会改变插件的「已生效实体数/最后事件」，面板状态行需要跟上。
    if (event.kind === 'brush') this.notifyStatusChanged();
  };

  /** 按需装载插件；失败时自动关掉该开关（避免每次启动都重试并刷错误）。 */
  private async ensureLoaded(id: string): Promise<EnhancePlugin | null> {
    if (this.disposed) return null;
    const existing = this.plugins.get(id);
    if (existing) return existing;
    const inflight = this.pending.get(id);
    if (inflight) return inflight;
    const factory = PLUGIN_FACTORIES[id];
    if (!factory) return null;
    const task = (async (): Promise<EnhancePlugin | null> => {
      try {
        const plugin = await factory(this.runtime);
        if (this.disposed) {
          plugin.dispose?.();
          return null;
        }
        this.plugins.set(id, plugin);
        if (this.plugins.size === 1) this.hooks.setEventSink(this.onEntityEvent);
        this.deps.log(`插件已启用：${id}`);
        this.notifyStatusChanged();
        return plugin;
      } catch (err) {
        this.deps.log(`插件装载失败：${id}（${String(err)}），已自动关闭`);
        this.enabled.delete(id);
        writeEnabledEnhanceIds(this.storage, [...this.enabled]);
        return null;
      } finally {
        this.pending.delete(id);
      }
    })();
    this.pending.set(id, task);
    return task;
  }

  /** 卸载并释放插件；最后一个卸载时把事件 sink 置空（回到零成本）。 */
  private unload(id: string): void {
    const plugin = this.plugins.get(id);
    if (!plugin) return;
    this.plugins.delete(id);
    try {
      plugin.dispose?.();
    } catch (err) {
      this.deps.log(`插件卸载异常：${id}（${String(err)}）`);
    }
    if (this.plugins.size === 0) this.hooks.setEventSink(null);
    this.deps.log(`插件已停用：${id}`);
  }
}
