/**
 * 回放导入入口：优先把解析交给 Worker（避免长时间占用主线程），Worker 不可用或启动失败时
 * 自动回退到主线程做同一套解析；两条路径都只接受 Shavit 原生 `.replay`。
 *
 * 数据流：`File` + `RuleConfig` → （Worker 或主线程）`parseShavitReplay` →
 * `clipFromShavitReplay` → `Clip`。Worker 消息与载荷类型见
 * `apps/viewer/src/replay/protocol.ts`，Worker 侧实现见 `apps/viewer/src/worker/main.ts`。
 *
 * 关键不变量：
 * - 「Worker 坏掉」是**单向**的：`ensureWorker` 一旦置 `workerBroken`（抛异常或被 `onerror` 捕获），
 *   后续每次都直接走主线程，不再重试起 Worker；
 * - 两条路径对调用方同形：都返回 `ImportResult`，并按同一个 `ProgressFn` 约定回调进度
 *   （Worker 侧发 `'parse'` 的 0/1 与 1/1 两条，主线程侧在同一位置回调同样的值）；
 * - 缓存的是**原始字节**而不是解析结果：Worker 侧按文件对象句柄复用（见
 *   `apps/viewer/src/worker/main.ts` 的 `cachedNativeFile`），主线程侧按 `mainNativeFile` 复用，
 *   两者都以「换成新文件就重新读字节」为界。
 *
 * 本仓调用关系：本文件唯一的外部消费者是 `apps/viewer/src/replay/panel.ts` 的
 * `ReplayPanel.runImport`（每条成员的调用点情况写在各成员自己的注释里）。
 */

import {
  clipFromShavitReplay,
  fileLooksLikeShavitReplay,
  parseShavitReplay,
} from './shavit-replay.js';
import type {
  ClipPayload,
  ParseRequest,
  ParseResponse,
} from './protocol.js';
import type { Clip, RuleConfig } from './types.js';
import { fileLooksLikeSourceDemo, parseSourceDemo } from './demo/demo.js';
import { demoTracksToClips } from './democlip.js';

/** 进度阶段取值：`'parse'` = 解析 `.replay`，`'map'` = 规则映射；当前只有 `'parse'` 会被发出。 */
export type ImportPhase = 'parse' | 'map';
/** 进度回调签名（阶段 + 已完成 + 总数）。 */
export type ProgressFn = (phase: ImportPhase, done: number, total: number) => void;

export interface ImportResult {
  /**
   * 本次导入产出的全部 `Clip`。Shavit `.replay` 恒为 1 份；Source `.dem` 是「每个被采出位姿的
   * 实体一份」（多人录像即多份）。调用方按顺序建轨道（首份替换当前轨道，其余追加）。
   */
  clips: Clip[];
  warnings: string[];
  /** 导入来源标识；Shavit 路径为 `.replay`，DEM 路径为 `<地图>.dem`（取自首份 `Clip.resolvedPath`）。 */
  resolvedPath: string;
  /**
   * 仅 Source `.dem` 路径携带：解析出来的录像元信息与诊断计数，供面板如实展示。
   * Shavit `.replay` 路径为 `undefined`（该格式没有这些概念）。
   */
  demo?: DemoImportInfo;
}

/** Source `.dem` 的解析摘要（面板展示用；字段全部取自 `DemoParseResult`，不做二次推算）。 */
export interface DemoImportInfo {
  /** 录像内的地图名（`DemoHeader.mapName`）。 */
  map: string;
  /** 网络协议号（CS:S / Orange Box 为 24）。 */
  networkProtocol: number;
  /** 录像总 tick 数。 */
  ticks: number;
  /** 录像总时长（秒）。 */
  seconds: number;
  /** 推出的 tick 率（`ticks / seconds`）。 */
  tickRate: number;
  /** `dem_stringtables` 解出的字符串表张数。 */
  stringTables: number;
  /** `dem_datatables` 解出的服务器类别数。 */
  classes: number;
  /** `svc_PacketEntities` 包解析成功数。 */
  packetOk: number;
  /** `svc_PacketEntities` 包总数。 */
  packetTotal: number;
  /** 位姿采样口径：`'players'` 玩家类且必须有朝向；`'playerPosed'` 玩家类、朝向可缺（记 0）；`'posed'` 任意有坐标的实体。 */
  sampleMode: 'players' | 'playerPosed' | 'posed';
  /** 采出的轨迹条数。 */
  tracks: number;
  /** 从 `userinfo` 字符串表解出的玩家名条数。 */
  playerNames: number;
  /**
   * 玩家位姿可信度的如实说明。实测：实体流「记录边界」尚未完全校准，玩家类实体的
   * `m_vecOrigin` / `m_angEyeAngles` 可能取不到或不可用——这句话原样展示给用户，不隐藏。
   */
  note: string;
}

/** pending 表的一项：响应到达时结算的 resolver / rejecter，外加本次请求的进度回调。 */
interface Pending {
  resolve: (v: ParseResponse) => void;
  reject: (e: Error) => void;
  onProgress?: ProgressFn;
}

export class ReplayImporter {
  /** 解析 Worker 实例；懒创建，`dispose` 后置回 null。 */
  private worker: Worker | null = null;
  /** Worker 不可用标记：一旦为 true，`ensureWorker` 直接返回 null（不重试）。 */
  private workerBroken = false;
  /** 请求序号：`import` 每次自增并写进 `ParseRequest.id`，Worker 回填同一个 id。 */
  private seq = 0;
  /** 未结算请求表：key = `ParseRequest.id`；进度响应用它找回回调，终结响应把它删掉。 */
  private readonly pending = new Map<number, Pending>();
  /** 主线程回退路径的字节缓存句柄（与 `mainNativeBytes` 配套）。 */
  private mainNativeFile: File | null = null;
  /** 主线程回退路径缓存的原始字节（Worker 路径不写它）。 */
  private mainNativeBytes: ArrayBuffer | null = null;

  /**
   * 取（或懒建）Worker：首次创建时优先用单文件构建内嵌的 Worker 源码起 Blob Worker，
   * 没有内嵌源码才按模块 Worker 加载 `apps/viewer/web/worker.js`。
   *
   * 副作用与边界：
   * - 挂 `onmessage`（按 `id` 配回 pending：`'progress'` 只转发回调不结算，其余终结请求）
   *   与 `onerror`（置 `workerBroken`、终止并丢弃 Worker、用同一个错误拒绝全部未结算请求）；
   * - 构造期抛异常同样置 `workerBroken` 并返回 null；
   * - `workerBroken` 已置位时不再尝试创建。
   */
  private ensureWorker(): Worker | null {
    if (this.workerBroken) return null;
    if (this.worker) return this.worker;
    try {
      // 单文件（file:// 双击）构建：Worker 代码内嵌在 globalThis.__VBSP_WORKER_JS__，
      // 用 Blob URL 起 Worker（file:// 下 new URL(..., import.meta.url) 的 module worker 会被拦）
      const g = globalThis as { __VBSP_WORKER_JS__?: unknown };
      let w: Worker;
      if (typeof g.__VBSP_WORKER_JS__ === 'string' && g.__VBSP_WORKER_JS__.length > 0) {
        const blob = new Blob([g.__VBSP_WORKER_JS__], { type: 'text/javascript' });
        w = new Worker(URL.createObjectURL(blob));
      } else {
        w = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
      }
      w.onmessage = (e: MessageEvent) => {
        const msg = e.data as ParseResponse;
        const p = this.pending.get(msg.id);
        if (!p) return;
        if (msg.type === 'progress') {
          p.onProgress?.(msg.phase, msg.done, msg.total);
          return;
        }
        this.pending.delete(msg.id);
        p.resolve(msg);
      };
      w.onerror = (e) => {
        // Worker 起不来（缺少 worker.js 等）：后续全部走主线程
        this.workerBroken = true;
        this.worker?.terminate();
        this.worker = null;
        const err = new Error(`解析 Worker 启动失败（${e.message || '未知原因'}），已改用主线程解析`);
        for (const p of this.pending.values()) p.reject(err);
        this.pending.clear();
      };
      this.worker = w;
      return w;
    } catch {
      this.workerBroken = true;
      return null;
    }
  }

  /** 无 Worker 可用时用哨兵错误拒绝（`import` 据此转主线程）。 */
  private send(req: ParseRequest, onProgress?: ProgressFn): Promise<ParseResponse> {
    const w = this.ensureWorker();
    if (!w) return Promise.reject(new Error('__NO_WORKER__'));
    return new Promise<ParseResponse>((resolve, reject) => {
      this.pending.set(req.id, { resolve, reject, onProgress });
      w.postMessage(req);
    });
  }

  /**
   * 导入一份记录 / 录像并生成 `Clip`：先试 Worker，`send` 抛哨兵错误或 `workerBroken` 已置位时
   * 改走 `importOnMain`（同源解析）；其余异常原样上抛。
   *
   * `file` 为 null 时交由解析侧复用自己缓存的上一份文件——本仓唯一调用点
   * （`apps/viewer/src/replay/panel.ts` 的 `ReplayPanel.runImport`）保证非空。
   * 边界：`postMessage` 成功但 Worker 始终不回消息时，本 Promise 不设超时、不会被结算。
   */
  async import(
    file: File | null,
    rule: RuleConfig,
    name: string,
    onProgress?: ProgressFn,
  ): Promise<ImportResult> {
    // Source `.dem` 录像走独立的原生解析路径，且**不经 Worker**（Worker 协议只承载单一
    // Shavit 载荷）；嗅探只看 8 字节魔数 `HL2DEMO\0`，不影响 `.replay` 路径。
    if (file && (await fileLooksLikeSourceDemo(file))) {
      return this.importDemoOnMain(file, rule, name, onProgress);
    }
    try {
      const res = await this.send({ id: ++this.seq, type: 'import', file, rule, name }, onProgress);
      if (res.type === 'error') throw new Error(res.message);
      if (res.type !== 'done') throw new Error('导入返回了意外的响应类型');
      return {
        clips: res.payloads.map((p) => payloadToClip(p, rule)),
        warnings: res.warnings,
        resolvedPath: res.resolvedPath,
      };
    } catch (e) {
      if (isNoWorker(e) || this.workerBroken) return this.importOnMain(file, rule, name, onProgress);
      throw e;
    }
  }

  /**
   * Source `.dem` 的主线程导入路径：解析容器/发送表/实体流，采出实体位姿轨迹，再按
   * `apps/viewer/src/replay/democlip.ts` 的桥接规则转成 `Clip`。
   *
   * **单 clip 契约**：`ImportResult` 只承载一份 `Clip`，而一份 `.dem` 天然会产出多条轨迹
   * （录像里有几个会动的实体就有几条）。这里取**采样点最多**的那条作为本次导入的 clip，其余
   * 条数与名字写进 `warnings` 供面板显示——多人轨道要等导入契约扩成多 clip 后再放开。
   *
   * 采样口径先按 `'players'`（只采玩家类）；一条都没有时退回 `'posed'`（采任何有世界坐标的
   * 实体），并在 `warnings` 里说明——空服自动录像只有后者能采出东西。
   */
  private async importDemoOnMain(
    target: File,
    rule: RuleConfig,
    name: string,
    onProgress?: ProgressFn,
  ): Promise<ImportResult> {
    onProgress?.('parse', 0, 1);
    const bytes = await target.arrayBuffer();
    let result = parseSourceDemo(new Uint8Array(bytes), { sampleMode: 'players' });
    const warnings: string[] = [];
    let clips = demoTracksToClips(result, { rule });
    let sampleMode: 'players' | 'playerPosed' | 'posed' = 'players';
    if (clips.length === 0) {
      // 第二档：玩家类 + 有坐标即可（朝向缺失记 0）。实测 `m_angEyeAngles` 在真录像里极少下发，
      // 若直接跳到 `posed` 会把玩家轨迹淹没在各种服务器实体里，用户看不到真人走位。
      sampleMode = 'playerPosed';
      result = parseSourceDemo(new Uint8Array(bytes), { sampleMode });
      clips = demoTracksToClips(result, { rule });
      if (clips.length > 0) {
        warnings.push(
          `玩家类实体没有下发朝向（m_angEyeAngles），已按「玩家类 + 世界坐标」口径采出 ${clips.length} 条轨迹（朝向记 0）`,
        );
      }
    }
    if (clips.length === 0) {
      sampleMode = 'posed';
      result = parseSourceDemo(new Uint8Array(bytes), { sampleMode });
      clips = demoTracksToClips(result, { rule });
      warnings.push(
        `录像里没有玩家类实体的位姿轨迹，已改用「任意有世界坐标的实体」口径（采出 ${clips.length} 条）`,
      );
    }
    onProgress?.('parse', 1, 1);
    if (clips.length === 0) {
      throw new Error(`${name} 里没有可播放的位姿轨迹（没有实体被发送过世界坐标）`);
    }
    const h = result.header;
    warnings.unshift(
      `Source 录像：协议 ${h.networkprotocol}、地图 ${h.mapName}、` +
        `${h.playbackTicks} tick / ${h.playbackTime.toFixed(1)}s；` +
        `包 ${result.stats.packetsParsed}/${result.stats.packetsParsed + result.stats.packetsFailed} 解析成功；` +
        `采出 ${clips.length} 条实体轨迹`,
    );
    // 采样多的排前面（面板按顺序建轨道，首条替换当前轨道）
    clips = [...clips].sort((a, b) => b.count - a.count);
    if (name) clips[0].name = name;
    const seconds = h.playbackTime;
    const demo: DemoImportInfo = {
      map: h.mapName,
      networkProtocol: h.networkprotocol,
      ticks: h.playbackTicks,
      seconds,
      tickRate: seconds > 0 ? h.playbackTicks / seconds : 0,
      stringTables: result.stringTables.length,
      classes: result.dataTables.classes.length,
      packetOk: result.stats.packetsParsed,
      packetTotal: result.stats.packetsParsed + result.stats.packetsFailed,
      sampleMode,
      tracks: clips.length,
      playerNames: result.playerNames.size,
      note:
        result.playerNames.size === 0
          ? '录像开始时的 userinfo 里没有真人玩家（只有录制机器人），且中途加入的玩家走 svc_UpdateStringTable、本工程尚未解条目；实体流的记录边界也还没完全校准，故玩家位姿暂不可用。'
          : '实体流的记录边界尚未完全校准，玩家位姿可能不完整——下方轨迹数与帧数以实际解出的为准。',
    };
    return { clips, warnings, resolvedPath: clips[0].resolvedPath, demo };
  }

  /** 终止 Worker 并清空未结算请求表（不置 `workerBroken`，下次 `import` 会重新起 Worker）；本仓无调用点。 */
  dispose(): void {
    this.worker?.terminate();
    this.worker = null;
    this.pending.clear();
  }

  // ── 主线程回退（与 Worker 同源：嗅探 → 字节缓存 → 原生解析 → Clip）──

  /**
   * 主线程回退路径：目标文件取 `file ?? mainNativeFile`，两者都为空则抛错。
   * 先按魔数嗅探（是二进制判定，不做文本解码），非 `.replay` 直接抛错；
   * 字节只在「命中同一文件句柄」时复用缓存，否则重新 `arrayBuffer()` 并覆盖缓存。
   *
   * `ProgressFn` 的数值口径与 Worker 侧一致（`'parse'` 的 0/1 与 1/1），
   * 故面板按阶段读进度时两条路径表现一致。
   */
  private async importOnMain(
    file: File | null,
    rule: RuleConfig,
    name: string,
    onProgress?: ProgressFn,
  ): Promise<ImportResult> {
    const target = file ?? this.mainNativeFile;
    if (!target) throw new Error('没有可解析的文件');

    // 魔数嗅探必须在 text() 之前——Shavit .replay 是二进制，文本解码会破坏它
    if (!(await fileLooksLikeShavitReplay(target))) {
      throw new Error(
        `${name} 不是 Shavit .replay 录像文件——viewer 只支持 Shavit 原生 .replay（JSON/规则脚本通道已移除）`,
      );
    }

    onProgress?.('parse', 0, 1);
    let bytes = this.mainNativeFile === target ? this.mainNativeBytes : null;
    if (!bytes) {
      bytes = await target.arrayBuffer();
      this.mainNativeFile = target;
      this.mainNativeBytes = bytes;
    }
    const parsed = parseShavitReplay(bytes, {
      // File.lastModified 是 ms；.replay 头部 iTimestamp 是 Unix 秒（mtime 兜底同单位）
      timestampFallback: Math.floor(target.lastModified / 1000),
      // 坐标映射切换（默认 shavit 定标映射；仅用户显式切换时非默认）
      mapping: { axesMode: rule.axesMode, yawMode: rule.yawMode },
    });
    onProgress?.('parse', 1, 1);
    const { clip, warnings } = clipFromShavitReplay(name, parsed, rule);
    return { clips: [clip], warnings, resolvedPath: clip.resolvedPath };
  }
}

/** 是否为「无 Worker」哨兵错误（`send` 在 `ensureWorker` 返回 null 时抛出的那一条）。 */
function isNoWorker(e: unknown): boolean {
  return e instanceof Error && e.message === '__NO_WORKER__';
}

/**
 * Worker 载荷 → `Clip`：载荷里没有 `id` 与 `rule`（见
 * `apps/viewer/src/replay/protocol.ts` 的 `ClipPayload`），故 `id` 用「当前时间戳的 36 进制」
 * 现场生成，`rule` 取本次导入请求的规则快照。
 */
function payloadToClip(p: ClipPayload, rule: RuleConfig): Clip {
  return {
    id: `clip-${Date.now().toString(36)}`,
    name: p.name,
    count: p.count,
    t: p.t,
    pos: p.pos,
    ang: p.ang,
    vel: p.vel,
    duration: p.duration,
    bbox: p.bbox,
    maxSpeed: p.maxSpeed,
    resolvedPath: p.resolvedPath,
    rule,
    buttons: p.buttons,
    meta: p.meta,
  };
}
