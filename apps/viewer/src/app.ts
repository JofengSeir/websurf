/**
 * WebSurf-viewer — BSP 地图预览 + Shavit `.replay` 记录回放 + Source `.dem` 录像回放。
 *
 * 主线程装配：场景 / 飞行相机 / 地图信息 / 出生点导航 / 两个**互相独立**的回放会话。本文件是
 * viewer 的入口（`apps/viewer/package.json` 的 `build:app` 用 esbuild 打成 `web/app.js`）。
 * 定位是**纯视觉**：不引入物理与碰撞，记录与录像只做播放与观察。
 *
 * 导入去向由**文件内容**决定：三个入口（拖拽 / 引导层 / 两个面板的文件框）都汇进 `routeFile`
 * 按文件头魔数分派（见 `apps/viewer/src/core/filekind.ts`），扩展名不参与判定。
 *
 * **两个回放会话各持一份完整状态**（`apps/viewer/src/replay/session.ts` 的 `ReplaySession`）：
 * 各自的播放器 / 轨道 / 3D 呈现 / 时间轴 DOM / 能力档。切 tab 只做一件事 —— 一个会话下场、
 * 另一个上场；`#dock` 里两层 `.session-pane` 随之切换。两边不共享任何可变状态，故
 * 「记录页的时长被录像撑长」「一边的轨道出现在另一边的时间轴上」这类串位在结构上不会发生。
 *
 * 全局唯一的共享面只有三样：`three` 场景、飞行相机、以及 dock 之外的 HUD 与遥测读数 ——
 * 它们**只读活动会话**，不持有任何会话状态。
 *
 * 对外接口 = `globalThis.viewer` 的 `map`（只读内省）、`replay` / `demo`（两个会话各自的内省
 * 与播放控制）与 `session`（当前上场的会话）。
 */

import { DEG2RAD } from './core/constants.js';
import { ViewerScene } from './core/scene.js';
import { FlyCam } from './core/fly.js';
import { resolveInitialSpawn } from './core/spawn.js';
import type { ResolvedSpawn, SpawnSource } from './core/spawn.js';
import type { Pose } from './core/pose.js';
import { humanizeBspError, loadBspFile } from './core/bsp.js';
import type { BspLoadResult } from './core/bsp.js';
import { sniffFileKind } from './core/filekind.js';
import { qs } from './core/dom.js';
import { Hud } from './ui/hud.js';
import { MapPanel } from './ui/mapinfo.js';
import type { WorldBox } from './ui/mapinfo.js';
import { TelemetryHud } from './ui/telemetry.js';
import { DemoMetaStrip } from './ui/demometa.js';
import { ChatOverlay } from './ui/chatoverlay.js';
import { ReplayImporter } from './replay/importer.js';
import { ReplayPanel } from './replay/panel.js';
import { DemoPanel } from './replay/demopanel.js';
import { ReplaySession } from './replay/session.js';
import type { SessionKind } from './replay/session.js';
import { looksLikeShavitReplay, SHAVIT_SNIFF_BYTES } from './replay/shavit-replay.js';
import { defaultRule } from './replay/types.js';
import type { Track } from './replay/types.js';

const canvas = document.getElementById('game') as HTMLCanvasElement | null;
if (!canvas) throw new Error('canvas#game 未找到');
const gameCanvas: HTMLCanvasElement = canvas;

// 部署环境状态提示：viewer 不做通道选择（无物理、不需要 SharedArrayBuffer），只打印该状态供核对；
// debug / game 的入口用同一标志决定走共享内存通道还是 postMessage 回退。
const crossOriginIsolatedViewer =
  (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated === true;
console.log(
  `[viewer] crossOriginIsolated=${crossOriginIsolatedViewer}` +
    (crossOriginIsolatedViewer ? '' : '（viewer 无物理，不依赖此状态——仅作部署环境参考）'),
);

const hud = new Hud();

let scene: ViewerScene;
try {
  scene = new ViewerScene(gameCanvas);
} catch (e) {
  hud.showFatal(
    '无法创建 WebGL 渲染上下文（' + (e instanceof Error ? e.message : String(e)) + '）。\n' +
      '常见原因：浏览器禁用了 WebGL / 硬件加速未开启 / 显卡驱动过旧。',
  );
  throw e;
}

const fly = new FlyCam();
fly.attach(gameCanvas);
fly.onLockError = () => hud.flashStatus('鼠标锁定失败，请再点击一次画布重试');

// ── 侧栏与标签页 / 底部 dock（两个会话各一层）────────────────────────
const sidebarEl = qs('sidebar');
const dockEl = qs('dock');
const telemetryEl = qs('telemetry');
const sidebarToggle = qs<HTMLButtonElement>('sidebarToggle');

sidebarToggle?.addEventListener('click', () => {
  const hidden = sidebarEl?.classList.toggle('hidden') ?? false;
  sidebarToggle.classList.toggle('active', !hidden);
  dockEl?.classList.toggle('full', hidden);
  // 速度 HUD 锚点跟随可视区域：面板收起 → 全屏居中
  telemetryEl?.classList.toggle('full', hidden);
});

// ── 两个回放会话 ────────────────────────────────────────────────────
/**
 * 记录会话的容器 = `#session-replay`（内含信息条 `#replayMeta` 与时间轴 `#timeline`）；
 * 录像会话的容器 = `#session-demo`（只含时间轴 `#timelineDemo` —— `.dem` 没有 `.replay`
 * 那样的文件头，故这一层没有信息条，元信息由录像页看板自己展示）。
 * 容器元素缺失时兜底成游离 div：会话仍可构造，只是不上屏（与既有的 `qs(...) ?? createElement` 口径一致）。
 */
const dockFallback = (): HTMLElement => document.createElement('div');
const sessions: Record<SessionKind, ReplaySession> = {
  replay: new ReplaySession(
    'replay',
    scene,
    qs('session-replay') ?? dockFallback(),
    qs('timeline') ?? dockFallback(),
    qs('replayMeta'),
  ),
  demo: new ReplaySession(
    'demo',
    scene,
    qs('session-demo') ?? dockFallback(),
    qs('timelineDemo') ?? dockFallback(),
    null,
  ),
};

/** 当前上场的回放会话：帧循环、相机与 HUD 读数都只读它。 */
let activeKind: SessionKind = 'replay';
function activeSession(): ReplaySession {
  return sessions[activeKind];
}

// ── 遥测 HUD（速度读数 + 按键簇）─────────────────────────────────────
// 速度读数挂顶层 `#telemetry`（定位由 CSS 决定），按键簇挂**记录会话**那条时间轴的右列 ——
// `.dem` 的 `Clip.buttons` 恒 `null`（Source 只把录制者本人的输入写进 usercmd），
// 没有真值就不该建一排永远不亮的灯，故录像会话的时间轴上根本没有按键簇。
const telemetry = new TelemetryHud(
  telemetryEl ?? dockFallback(),
  sessions.replay.timelineRoot,
);

// **录像信息条**（`#demoInfo`，录像会话 dock 上层）：录像侧独有的展示位，内容来自 `.dem` 解析产物
// （由 `demoPanel` 的 `onParsed` 推入）。与记录会话的 `#replayMeta` 是**两个元素、两个写者** ——
// 记录条归 `ReplaySession` 的 `ReplayMetaPanel`，两者互不触碰对方的容器。
const demoInfo = new DemoMetaStrip(qs('demoInfo') ?? dockFallback());

// **画面左下角的对话浮层**（`#chatOverlay`）：只显示录像「当前这一刻」附近的几条聊天
// （15 秒淡出 / 同屏最多 5 条 / 超出丢最早那条 / 最底下是最晚的）。数据由 `onParsed` 一次性推入，
// 时间由帧循环推进（见 `frame()`）；`bottom` 由它按 `#dock` 高度动态让位。
const chatOverlay = new ChatOverlay(qs('chatOverlay') ?? dockFallback(), qs('dock'));

/** 速度读数的显隐跟随**当前上场会话**有没有内容（录像载入完但还没点人时也该显示）。 */
function syncTelemetry(): void {
  telemetry.setTracks(activeSession().ready);
}

/** 会话状态变化后的统一收尾：同步本会话的 3D / 时间轴 / 信息条，并按需刷新全局遥测显隐。 */
function syncSession(kind: SessionKind): void {
  sessions[kind].sync();
  if (activeKind === kind) syncTelemetry();
}

/** 会话上场（唯一的状态切换原语；`deactivate` 对已下场的会话是空操作）。 */
function setActiveSession(kind: SessionKind): void {
  if (activeKind !== kind) sessions[activeKind].deactivate();
  activeKind = kind;
  sessions[kind].activate();
  syncTelemetry();
  sessions[kind].timeline.refresh();
  // **对话浮层只在录像会话上场时露面**（记录链路没有对话数据；数据留着，切回来立刻恢复）。
  chatOverlay.setShown(kind === 'demo');
}

// ── 标签页 ──────────────────────────────────────────────────────────
const tabButtons = Array.from(document.querySelectorAll<HTMLButtonElement>('.tab'));
const tabPanes = Array.from(document.querySelectorAll<HTMLElement>('.tabpane'));

/**
 * **唯一的 tab 切换点**。
 *
 * 切到「记录」/「录像」= 把对应会话请上场（另一个下场：停表 + 3D 熄灭，状态全部留着）。
 * 切到「地图」**不改会话** —— 底部 dock 仍停在上一个回放会话上、相机也仍由它驱动，
 * 与改造前的行为一致；地图页只是多了一个可看的页面。
 */
function switchTab(name: string): void {
  for (const t of tabButtons) t.classList.toggle('active', t.dataset.tab === name);
  for (const pane of tabPanes) pane.classList.toggle('active', pane.id === `pane-${name}`);
  if (name === 'replay' || name === 'demo') setActiveSession(name);
  // 回放页的面板在侧栏里：进回放页时把收起的侧栏放回来（dock 全宽与速度 HUD 居中随之还原，
  // 与 sidebarToggle 的 toggle 成对）。
  if (name !== 'map' && sidebarEl?.classList.contains('hidden')) {
    sidebarEl.classList.remove('hidden');
    sidebarToggle?.classList.add('active');
    dockEl?.classList.remove('full');
    telemetryEl?.classList.remove('full');
  }
}

for (const tab of tabButtons) {
  tab.addEventListener('click', () => {
    const name = tab.dataset.tab;
    if (name) switchTab(name);
  });
}

function activateTab(name: string): void {
  switchTab(name);
}

// ── 地图信息 / 出生点 ────────────────────────────────────────────────
const mapPane = qs('pane-map');

/** 当前地图包围盒（记录轨迹地图贴合检查用）。 */
let currentBox: WorldBox | null = null;

function applyPose(pose: Pose): void {
  fly.setPose(pose);
}

const mapPanel =
  mapPane &&
  new MapPanel(
    mapPane,
    (pose) => {
      // 回放中相机由活动会话驱动，出生点跳转不抢镜头（想自由观察请切第三人称）
      if (activeSession().cameraSample()) return;
      applyPose(pose);
    },
    // 光照模式（预烘焙 / 纯纹理）：运行期 uniform 切换，不重建场景（与 game/debug 同语义）
    (mode) => scene?.setLightingMode(mode),
  );

// **启动时先渲染一次「无地图」空态**：`MapPanel` 的两个子渲染都有「尚未加载地图」的占位分支，
// 但此前**没有任何调用点在启动时走到它们** —— 于是「出生点导航」分节一直是"只有标题、
// 底下什么都没有"，看起来像坏了（审计实测：0 子元素 / 0 文字）。`setMap(null, null)`
// 正是为这个空态准备的分支（`renderInfo` 与 `renderSpawns` 都处理 null）。
mapPanel?.setMap(null, null);

// ── 记录会话（Shavit `.replay`）─────────────────────────────────────
const importer = new ReplayImporter();
const replay = sessions.replay;
const replayPane = qs('pane-replay');
let replayPanel: ReplayPanel | null = null;

/**
 * 地图贴合检查，合并成一条 HUD 提醒（只写 `#replayStatus`；用户未必停在记录页，故走跨面提醒）。
 *
 * 判据：某条**记录轨道**的 `Clip.bbox` 与当前地图包围盒在**三轴全部**分离、且间隙超过 `pad`（512 HU）
 * 时判「完全落在地图包围盒外」。这通常说明坐标映射选错了（`.replay` 的帧就是自身坐标，
 * 应改记录页的「坐标映射」而不是靠平移把轨迹挪回去）。
 *
 * 只看记录会话的轨道：录像（`.dem`）的坐标取自录像内的世界坐标，与当前地图是否加载无关，
 * 也不该在加载一张无关地图时被这条提醒牵连。
 */
function updateReplayMapStatus(): void {
  const tracks = replay.player.tracks.tracks;
  if (tracks.length === 0) {
    hud.setReplayStatus('');
    return;
  }
  const msgs: string[] = [];

  if (currentBox) {
    const pad = 512;
    const outside = tracks.filter((t) => {
      const b = t.clip.bbox;
      return (
        b.max[0] < currentBox!.min[0] - pad ||
        b.min[0] > currentBox!.max[0] + pad ||
        b.max[1] < currentBox!.min[1] - pad ||
        b.min[1] > currentBox!.max[1] + pad ||
        b.max[2] < currentBox!.min[2] - pad ||
        b.min[2] > currentBox!.max[2] + pad
      );
    });
    if (outside.length > 0) {
      const b = outside[0].clip.bbox;
      msgs.push(
        `${outside.map((t) => `「${t.name}」`).join('、')}完全落在地图包围盒外` +
          `（bbox min ${tip(b.min)} / max ${tip(b.max)}）`,
      );
    }
  }

  hud.setReplayStatus(msgs.length > 0 ? '⚠ ' + msgs.join('；') : '');
}

function tip(a: [number, number, number]): string {
  return `${a[0].toFixed(0)},${a[1].toFixed(0)},${a[2].toFixed(0)}`;
}

if (replayPane) {
  replayPanel = new ReplayPanel(replayPane, importer, replay.player, {
    // **选错文件就改送**：记录页的文件框只收 `.replay`，但用户在系统对话框里可以切「所有文件」
    // 硬选一份 `.dem`/`.bsp` ——本面板按内容复核后交回 `routeFile`，由它切到对应页面
    // （旧实现让这份 `.dem` 在本页被解析成普通轨道，就是「录像被导向记录页」的根因）。
    onForeignFile: (f) => void routeFile(f),
    onClip: (clip, _warnings, replaceId) => {
      // 改映射/变换后的重新导入 → 替换那条轨道（保留配色/显隐/偏移）；换文件才追加
      let track: Track | null = null;
      if (replaceId && replay.player.tracks.replaceClip(replaceId, clip)) {
        track = replay.player.tracks.tracks.find((t) => t.id === replaceId) ?? null;
      }
      if (!track) track = replay.player.addTrack(clip);
      // 看记录默认第一人称跟随（有轨道后第三人称需手动切回）
      replay.player.mode = 'first';
      syncSession('replay');
      replayPanel?.refreshTracks();
      updateReplayMapStatus();
      return track.id;
    },
    onClearAll: () => {
      replay.player.clearTracks();
      syncSession('replay');
      replayPanel?.refreshTracks();
      hud.setReplayStatus('');
    },
    // 轨道属性变化（显隐 / 偏移 / 跟随 / 重命名）：TrackPanel 自己重绘列表，这里重建 3D、时间轴与信息条
    onTracksChanged: () => syncSession('replay'),
    onStatus: (text) => {
      // 回放域临时消息（导入进度 / 工具结果）走 HUD 提醒行；'' 立即恢复持久内容
      hud.flashReplayStatus(text, 8000);
    },
  });
}

// ── 录像会话（Source `.dem`）────────────────────────────────────────
// 独立于记录会话：`.dem` 给不出定长位姿，看板是「时间线 + 玩家标注 + 详情」，不复用轨迹列表布局。
const demo = sessions.demo;
// **用户拖进度条的通报**：录像会话那条时间轴的滑杆一动就记时刻（见 `userSeekAt` 的说明）。
// 只挂录像会话 —— 记录（`.replay`）链路没有「按区间换绑视角」这回事，不需要让方向。
demo.timeline.onUserSeek = () => {
  userSeekAt = performance.now();
};
const demoPane = qs('pane-demo');
/** 录像会话自己建的那条轨道 id：点选是「切换看谁」，复用它做替换（见 `onClip`）。 */
let demoTrackId: string | null = null;
/** 该轨道当前呈现的**实体号**（取自 `clip.id` 尾段）——改名时用它判断该不该改。 */
let demoTrackEntity: number | null = null;
/** **自动跟随视角**：录像载入后为真 —— 播放头进入谁的活跃区间就切到谁。用户自己点人后置假。 */
let autoFollow = false;
/** 自动跟随当前锁定的实体号（null = 还没锁定）。 */
let autoFollowEntity: number | null = null;
/**
 * **用户最后一次亲手拖进度条的时刻**（`performance.now()`）。
 *
 * 用途：拖动期间（以及松手后 0.7 秒内）自动跟随**让开方向** —— 缺口里的「跳到他重进那一刻」
 * 与「跟当前最快的那位」都不许抢用户拖到的位置（owner 实测：拖到两段中间被强制弹到第二段开头）。
 * 只由**滑杆**的 `input` 触发（`Timeline.onUserSeek`）；程序内部的 seek（深链 / 载入回零 / A-B 循环）
 * 不算用户操作，所以「播到缺口自动跳过」那条行为不受影响。
 */
let userSeekAt = 0;
/**
 * 已为「看着的那个人」跳过的**重进时刻**（tick）——同一段只跳一次。
 *
 * 为什么要这个闸：他退出后我们会把播放头直接跳到他重进那一刻（见帧循环里的说明）。若不记住
 * 「这一段跳过了」，用户手动把播放头拖回缺口时会被**再次**弹到他重进处 —— 那才是真的打断。
 * 他重新在场时清零，于是**下一次**退出/重进仍会跳。
 */
let autoFollowSkippedTo: number | null = null;
/**
 * 本次 `pickEntity` 是否由**自动跟随**发起。
 *
 * 为什么需要它：`onClip`（每次建/换轨道都会走）里会把 `autoFollow` 置假，代表「用户自己点了人、
 * 别再抢视角」—— 而自动跟随自己也要调 `pickEntity`，于是**第一次自动挑人就把自动跟随关掉了**，
 * 之后真人再进场、再回来都不会切（owner 实测「进度条滚到他第二次进来也没跟过去」）。
 * 只有**用户发起的**那一次才解除自动跟随。
 */
let autoPickInFlight = false;

const demoPanel = demoPane
  ? new DemoPanel(demoPane, {
      rule: () => defaultRule(),
      // **选错文件就改送**：录像页的文件框只收 `.dem`，但用户在系统对话框里可以切「所有文件」
      // 硬选一份 `.replay`/`.bsp` ——本面板按内容复核后交回 `routeFile`，由它切到对应页面。
      onForeignFile: (f) => void routeFile(f),
      // **名称轮换**：把当前播放位置换算成 tick 交给面板 —— 记录机器人会沿用同一个人物改名显示
      // 当前记录的关卡，故名字必须按 tick 取。tick 率取**本会话播放器**的当前位置与本录像头
      // 的真实值（总 tick / 总秒数）：这份录像实际是 66.67 tick，写死 100 会让「当前 tick」
      // 跑快 1.5 倍，播到后半段所有人都被判成离线。
      // 显式标注返回类型：这里引用了正在构造的 demoPanel 自身，否则 TS 推断会成环。
      currentTick: (): number => Math.round(demo.player.time * (demoPanel?.tickRate() ?? 1)),
      // **悬停看板某一行 ⇒ 在进度条上画出那一行的活跃区间**；移开清除。
      // 只动**录像会话**那条时间轴，记录会话那条完全不受影响。
      onHoverSpan: (spans) => demo.timeline.setHighlight(spans),
      // **tick 点按人物切换**：落到录像会话那条轨道上（录像会话有自己的 3D 呈现实例）。
      onTickToggle: (_entity: number, on: boolean) => {
        if (demoTrackId) demo.visuals.setTickNodesVisibleFor(demoTrackId, on);
      },
      // **信息条的名字要跟着播放头走**：`.dem` 的记录机器人会把名字改成「当前记录的关卡」，
      // 而轨道名在建轨道那一刻定死 ⇒ 面板检测到「跟随中那个人」改名时通知这里：
      // 改轨道名 + `syncSession('demo')` 重渲染（未真变时 rename 返回假，跳过刷新）。
      onWhoName: (entity: number, name: string) => {
        if (!demoTrackId || entity !== demoTrackEntity) return;
        if (demo.player.tracks.rename(demoTrackId, name)) syncSession('demo');
      },
      // **录像信息条**（底部 dock 上层，`#demoInfo`）：把解析产物交给录像会话那条信息条 ——
      // `.dem` 独有的服务器身份 / 天空盒 / 协议 / 事件 / 实体流规模 / 字符串表 / 包走读。
      // 它只写**录像会话**容器里的那个元素，记录会话的 `#replayMeta` 由 `ReplayMetaPanel` 管。
      onParsed: (result, file, rosterCount) => {
        demoInfo.set(result ? { fileName: file.name, result, rosterCount } : null);
        // **画面左下角的对话浮层**：数据就是同一份解析产物里的 `chat`（每条带 tick），
        // 在这里一次性换算成**会话内秒**交给浮层；解析失败（`result === null`）⇒ 清空
        // （清空这一步不能交给 `feedChatOverlay()`：面板里还留着上一份的 `result`）。
        if (!result) {
          chatOverlay.set(null);
          return;
        }
        // 过滤（面板上那四个勾选框）走 `feedChatOverlay()` —— 它取的是**面板过滤后**的那一份。
        feedChatOverlay();
      },
      // **勾选框变了 ⇒ 浮层跟着换一份**（浮层与侧栏列表必须同一口径，否则「滤掉了却还在飘」）。
      onChatFilter: () => feedChatOverlay(),
      /**
       * **点了一条过关记录 ⇒ 跳到那一跑**（owner 要求）。
       *
       * `toSec` 由面板算好（播报时刻 − 用时 − 5 秒缓冲，见 `chat/demo/chatkind.ts` 的
       * `recordJumpSeconds`）；这里只负责落两件事：
       * ① **把播放头跳过去**（`seek` 夹在区间内，运行状态不动 —— 用户在暂停看录像时点跳转，
       *    不该被强行播起来，与「换绑不许改播放态」是同一条规矩）；
       * ② **顺手把视角切到过的那个人**（按名字认人：`.dem` 里同名很少见；认不到就只跳时间）。
       */
      onRecordJump: (toSec, announceSec, player, level, durationSec) => {
        const who = player.trim();
        const row = who.length > 0 ? demoPanel?.roster(0).find((p) => p.name.trim() === who) : undefined;
        // **顺序不能反**：先切视角、**最后**再定位播放头。
        // `pickEntity` 会走到「播放头不在这个人的区间里就 seek 到区间起点」那条路（`jumpTo`），
        // 于是它自己会动播放头 —— 先 seek 再切视角的话，我们算好的目标时刻会被它覆盖
        // （本轮实测：点 9:37 的过关记录，播放头落到了他这一段开头的 4:36）。
        if (row && row.hasTrack) {
          autoPickInFlight = true;
          demoPanel?.pickEntity(row.entity);
          autoPickInFlight = false;
        }
        demo.player.seek(toSec);
        // 进度条上把「刚跳到的那一段」画出来（落点 → 播报时刻）；播放头走过它就消失（帧循环负责清）。
        demo.timeline.setJumpSpan({
          from: toSec,
          to: announceSec,
          title:
            `刚跳到 ${player || '这一跑'}${level ? ' · ' + level : ''}：用时 ${durationSec.toFixed(3)} 秒` +
            `（播报 ${fmtClock(announceSec)} − 用时 − 5 秒缓冲 = ${fmtClock(toSec)}）` +
            ' —— 播放头走过这一段它就消失',
        });
        hud.flashStatus(
          `跳到 ${player || '这一跑'}${level ? ' · ' + level : ''} 的起点 ${fmtClock(toSec)}` +
            `（播报 − ${durationSec.toFixed(3)} 秒 − 5 秒缓冲）`,
        );
      },
      onLoaded: () => {
        // **无轨道也能播放/暂停**：把录像总时长写进**本会话**播放器的时长兜底
        // （否则载入完 play() 直接返回）。它只影响录像会话，记录会话的总长仍由自己的轨道决定。
        demo.player.sessionLength = demoPanel?.totalSeconds() ?? 0;
        syncSession('demo');
        // **载入完成后从 0s 开始播，并按播放头自动跟随视角**（owner 定稿）：
        // 不预先跳到任何人，而是**播到谁的区间就切到谁** —— 于是先是**最早那位（机器人）**，
        // 再往后**遇到第一位真人**时自动切到真人。`autoFollow` 为真时由帧循环驱动这件事；
        // 用户一旦自己点了人（`onClip`）就置假，不再自动抢视角。
        autoFollow = true;
        demo.player.seek(0);
        demo.player.play();
      },
      // 点选有轨迹的一行 → 建轨道 + 切第一人称 + **立刻播放**
      // （早先只建轨道不播放：视图停在 0 秒不动，看起来像「没反应」——这是「点了没动」的直接原因）
      onClip: (clip) => {
        // **点选是「切换看谁」，不是「再叠一条」**：早先每次点击都 `addTrack`，连点五次就得到五条
        // 轨道（表现为「多次点击会导致创建多个」）。这里记住录像页自己建的那条，后续点击**替换**它。
        // 若那条已被用户删掉（`replaceClip` 返回假），则退回追加。
        // 只有**用户自己点的**人解除自动跟随；自动跟随自己挑的人（`autoPickInFlight`）不算。
        if (!autoPickInFlight) autoFollow = false;
        let track: Track | null = demoTrackId ? (demo.player.tracks.tracks.find((t) => t.id === demoTrackId) ?? null) : null;
        if (track && demo.player.tracks.replaceClip(track.id, clip, clip.name)) {
          // 替换成功：沿用原 id
        } else {
          track = demo.player.addTrack(clip);
          demoTrackId = track.id;
        }
        // **给这条录像轨道写上「当前这个人」的颜色**：录像复用同一条轨道（切人只换数据），
        // 轨道色不会自己变，必须由这里按人物写入 —— 否则所有人共用第一个人的颜色。
        // 写入后，3D 里的轨迹线与看板色点取自同一个值（同一张 `TRACK_PALETTE`、同一取模口径）。
        const demEntity = Number(clip.id.split(':').pop());
        demoTrackEntity = demEntity;
        const demColor = demoPanel?.colorFor(demEntity) ?? track.color;
        demo.player.tracks.setColor(track.id, demColor);
        demoPanel?.setTrackColor(demColor);
        demo.player.followTrack(track.id);
        demo.player.mode = 'first';
        syncSession('demo');
        const start = clip.count > 0 ? clip.t[0] : 0;
        const end = clip.count > 0 ? clip.t[clip.count - 1] : 0;
        // **条上画出「当前视角人物」的活跃区间**（录像会话时间轴的 `.tl-zone-active`）。
        // **按身份给全部区间**：同一个人会中途退出又进来（两段甚至更多），压成一段会把那个断口抹掉；
        // 拿不到身份行时退回这条轨道自己的区间（那是「这条轨迹在这段时间有位姿」的口径）。
        const who = demoPanel?.rosterFor(demEntity);
        const whoSpans = who && who.spans.length > 0 ? who.spans : null;
        demo.timeline.setActiveSpan(
          clip.count > 0
            ? whoSpans
              ? whoSpans.map((sp): [number, number] => [
                  demoPanel?.secondsAt(sp.from) ?? 0,
                  demoPanel?.secondsAt(sp.to) ?? 0,
                ])
              : [[start, end]]
            : null,
        );
        // **时间怎么动**（owner 定稿）：
        //   当前时间**在他进服之前** ⇒ 跳到他进服那一刻（否则要空等他几十分钟）；
        //   当前时间**在他活跃区间内** ⇒ **不动时间**，只换视角（这就是「播放期间点击不要回到区间开头重播」）；
        //   当前时间**在他退场之后** ⇒ 跳回他区间的**起点重看**（否则当前时刻他没有画面，点了等于没反应）。
        // **把这个人物自己的 tick 点设置落到轨道上**（每人一份，切人时各自生效）。
        if (demoTrackId) demo.visuals.setTickNodesVisibleFor(demoTrackId, demoPanel?.tickVisibleFor(demEntity) ?? true);
        if (demo.player.time < start || demo.player.time > end) demo.player.seek(start);
        // **只有「用户自己点人」那一次才自动开播**（`autoPickInFlight` 为假）。
        // 自动换绑 / 自动跟随也会走到这里（比如**暂停着**把进度条拖进他的第二段 ⇒ 换绑那一段的轨迹），
        // 那时**不许把暂停变成播放** —— 用户按下的暂停是他自己的状态，换视角不该改它。
        // 早先这里无条件 `play()`：暂停在 30 s 拖到 500 s 会自己跑起来（owner 侧由文档代理读码发现）。
        if (!demo.player.playing && !autoPickInFlight) demo.player.play();
      },
    })
  : null;

// ── BSP 加载 ────────────────────────────────────────────────────────
const bspFileInput = qs<HTMLInputElement>('bspFile');
/**
 * 引导层「导入记录 / 录像」用的隐藏输入。
 *
 * 它**不属于任何面板**：选到的文件按内容分派（`.replay` → 记录页、`.dem` → 录像页）。
 * 旧实现是让引导层那枚按钮 `for="replayFile"` 转发到记录页的输入，于是从引导层选进来的
 * `.dem` 也落在记录页 —— 正是「一开始就错误导向记录 tab」的入口之一。
 */
const importFileInput = qs<HTMLInputElement>('importFile');
/** 首访卡片上的两个选择按钮（`label.filebtn`，靠 `for` 转发到隐藏 input）。
 *  曾经查的是 `#guideBtn`——页面上**没有这个 id**，busy 态因此从不出现。 */
const guideBtns = Array.from(document.querySelectorAll<HTMLElement>('#guide .filebtn'));

let bspLoading = false;

/** 加载中：首访卡两个按钮 / 地图页「更换地图」都进 busy 态（`.busy` = 半透明 + 禁点）。 */
function setLoadBusy(busy: boolean): void {
  for (const b of guideBtns) b.classList.toggle('busy', busy);
  mapPanel?.setLoadBusy(busy);
  if (bspFileInput) bspFileInput.disabled = busy;
}

async function loadBsp(file: File): Promise<void> {
  if (bspLoading) return;
  bspLoading = true;
  setLoadBusy(true);
  hud.clearGuideError();
  const prevStatus = hud.statusText(); // 换图失败后要还原的旧地图摘要
  try {
    hud.setStatus(`正在解析 ${file.name}（主线程 BSP 解析）…`);
    const result: BspLoadResult = await loadBspFile(file);
    await scene.mountGlb(result.glbBytes, result.skyboxTexture, { fogParams: result.fogParams, skyCamera: result.skyCamera, pvsJson: result.pvsJson });

    const box = scene.worldBox();
    if (box && Number.isFinite(box.min.x)) {
      currentBox = {
        min: [box.min.x, box.min.y, box.min.z],
        max: [box.max.x, box.max.y, box.max.z],
      };
    } else {
      currentBox = null;
    }
    // 初始视角回退需要几何 bbox，故必须在 worldBox 之后解析；面板 ★ 推荐标记与初始视角同源
    //（都走 resolveInitialSpawn 这一个入口）。
    const init = resolveInitialSpawn(result.spawnPoints, result.primary, currentBox);
    mapPanel?.setMap(result, currentBox, init?.index);
    updateReplayMapStatus();

    const glbKb = Math.round(result.glbBytes.byteLength / 1024);
    applyInitialPose(init);
    hud.setStatus(
      `${file.name}：${result.meta.magic ?? 'VBSP'}，${result.meta.num_brushes ?? 0} brushes，` +
        `${result.spawnPoints.length} 出生点，GLB ${glbKb} KB${initialPoseNote(init)}`,
    );
    hud.hideGuide();
  } catch (e) {
    const [human, raw] = humanizeBspError(e);
    console.error('[viewer] BSP 加载失败:', e);
    if (!scene.hasModel()) {
      hud.setStatus(`BSP 加载失败：${human}`);
      hud.showGuide();
      hud.showGuideError(human, raw);
    } else {
      // 换图失败：临时提示 5s，然后还原旧地图的常驻摘要（不把「正在解析」卡在状态行）
      hud.setStatus(prevStatus);
      hud.flashStatus(`新地图加载失败：${human}`, 5000);
    }
  } finally {
    bspLoading = false;
    setLoadBusy(false);
  }
}

/** 本次地图的初始视角来源（window.viewer.map.pose 内省用）。 */
let lastSpawnSource: SpawnSource | null = null;

/**
 * 应用初始视角。来源解析收敛在 `resolveInitialSpawn` 单点：出生点实体 → bbox 内的
 * `info_teleport_destination` → bbox 中心高位俯瞰（后者的 `index` 为 −1）。
 * `init` 为 null 时视角保持不动。
 */
function applyInitialPose(init: ResolvedSpawn | null): void {
  lastSpawnSource = init?.source ?? null;
  if (init) applyPose({ pos: init.pos, ang: init.ang });
}

/** HUD 状态行的初始视角注记：正常命中出生点不加注，回退路径说明来源。 */
function initialPoseNote(init: ResolvedSpawn | null): string {
  if (!init) return '（无出生点，初始视角不变）';
  switch (init.source) {
    case 'teleport-dest':
      return '（无玩家出生点，初始视角 = 传送目标）';
    case 'bbox-vantage':
      return '（无可用出生点，初始视角 = 包围盒高位俯瞰）';
    default:
      return '';
  }
}

bspFileInput?.addEventListener('change', () => {
  const file = bspFileInput.files?.[0];
  bspFileInput.value = '';
  if (file) void loadBsp(file);
});
// 引导层第二条按钮走的输入：不预设类型，一律按内容分派
importFileInput?.addEventListener('change', () => {
  const file = importFileInput.files?.[0];
  importFileInput.value = '';
  if (file) void routeFile(file);
});
// 首访卡按钮不需要 click 转发：它们是 `label[for]`，浏览器原生把点击交给对应 input
// （原先这里挂过一个 `#guideBtn` 监听，那个 id 在页面里不存在，属死链）。

// ── 导入分派：按文件内容（魔数）决定去向，不看扩展名 ──────────────────
/**
 * **所有导入入口的唯一分派点**：拖拽、引导层的「导入记录 / 录像」、两个面板的文件框、
 * 都把手上的文件交给它；判据是文件内容（`sniffFileKind` 读文件头魔数），不是扩展名。
 *
 * 于是「把 `.dem` 丢进记录页 / 把 `.replay` 丢进录像页」这类误选会**自动改送到对应页面**，
 * 而不是在错的那一页里被解析出东西来（旧实现的缺陷：记录页的文件框 `accept` 同时收两种，
 * 而引导层按钮又复用它，`.dem` 于是被当普通轨道追加进记录页）。
 *
 * 去向：`.bsp` → `loadBsp`（不切 tab，地图是全局的）；`.replay` → 记录会话 `ReplayPanel.loadFile`；
 * `.dem` → 录像会话 `DemoPanel.load`。三种都不命中时按「是否已加载地图」选提示通道。
 * 两个面板各自按内容复核，非本页类型经 `onForeignFile` 交回这里 —— 一次分派、两条复核，没有第二条路径。
 */
async function routeFile(file: File): Promise<void> {
  const kind = await sniffFileKind(file);
  if (kind === 'bsp') {
    await loadBsp(file);
    return;
  }
  if (kind === 'replay' || kind === 'rec') {
    activateTab('replay');
    await replayPanel?.loadFile(file);
    return;
  }
  if (kind === 'demo') {
    activateTab('demo');
    await demoPanel?.load(file);
    return;
  }
  const msg =
    `未加载：${file.name} 不是 .bsp / .replay / .rec / .dem` +
    `（按文件头魔数识别：VBSP / {SHAVITREPLAYFORMAT} / KSF .rec / HL2DEMO）`;
  if (!scene.hasModel()) hud.showGuideError(msg);
  else hud.flashStatus(msg, 5000);
}

// ── 拖拽：按内容分派（.bsp 加载地图，.replay 载入记录，.dem 载入录像）────
window.addEventListener('dragover', (e) => {
  e.preventDefault();
  hud.setDropActive(true);
});
window.addEventListener('dragleave', (e) => {
  if (!e.relatedTarget) hud.setDropActive(false);
});
window.addEventListener('drop', (e) => {
  e.preventDefault();
  hud.setDropActive(false);
  const file = e.dataTransfer?.files?.[0];
  if (!file) return;
  void routeFile(file);
});

// ── JS 接口：`globalThis.viewer`（地图内省 / 两个会话各自的内省与播放控制），供外部脚本与 headless 冒烟断言用 ──
/** 一个会话的只读快照 + 播放控制（两个会话形状一致，各自操作自己的播放器）。 */
function sessionApi(kind: SessionKind): Record<string, unknown> {
  const s = sessions[kind];
  const p = s.player;
  return {
    // 内省字段（只读快照，取值即当前状态）
    kind,
    /** 本会话是否上场。 */
    active: s.isActive,
    /** 本会话是否已有可播放内容（记录 = 有轨道；录像 = 已载入整段或已有轨道）。 */
    ready: s.ready,
    trackCount: p.tracks.tracks.length,
    duration: p.duration,
    /** 录像会话的整段时长兜底；记录会话恒 0（总长完全由轨道决定）。 */
    sessionLength: p.sessionLength,
    time: p.time,
    playing: p.playing,
    /** A-B 播放区间（秒，主时钟）；`rangeEnd <= rangeStart` 表示未设区间、按整段播放。 */
    rangeStart: p.rangeStart,
    rangeEnd: p.rangeEnd,
    speed: p.speed,
    mode: p.mode,
    followId: p.tracks.followId,
    /** 场景根(`THREE.Scene`)的子节点数（冒烟断言用；两个会话的对象都在同一个场景里）。 */
    sceneObjects: scene.scene.children.length,
    /** 各轨道只读信息（id / 名 / 帧数 / 时长 / 偏移 / 显隐 / 配色 / 首帧坐标）。 */
    tracks: () =>
      p.tracks.tracks.map((t) => ({
        id: t.id,
        name: t.name,
        frames: t.clip.count,
        duration: t.clip.duration,
        offset: t.offset,
        visible: t.visible,
        color: t.color,
        firstPos:
          t.clip.count > 0
            ? ([t.clip.pos[0], t.clip.pos[1], t.clip.pos[2]] as [number, number, number])
            : ([0, 0, 0] as [number, number, number]),
      })),
    /** 跟随轨道的 `.replay` 头部元信息（Clip.meta；无轨道 / 无元信息 / 录像会话 → null）。 */
    meta: () => s.metaOfFollow(),
    // 播放控制（时间单位 = 秒，主时钟；seek 夹到当前区间 [rangeStart, rangeStop]）
    play: () => p.play(),
    pause: () => p.pause(),
    seek: (sec: number) => p.seek(sec),
    setSpeed: (x: number) => {
      p.speed = Math.max(0.1, Math.min(16, Number(x) || 1));
    },
    /** 视角模式：只有 'third' 按第三人称处理，其余入参一律落到 'first'。 */
    setMode: (m: 'first' | 'third') => {
      p.mode = m === 'third' ? 'third' : 'first';
    },
    /** 切换第一人称跟随目标；null = 回到第一条轨道。 */
    follow: (trackId: string | null) => {
      const before = p.tracks.followId;
      if (trackId === null) {
        const t0 = p.tracks.tracks[0];
        if (t0) p.followTrack(t0.id);
      } else {
        p.followTrack(trackId);
      }
      // API 跟随切换与面板 ◎ 按钮同语义：3D / 时间轴 / 信息条 / 轨迹列表都要刷新
      if (p.tracks.followId !== before) {
        syncSession(kind);
        if (kind === 'replay') replayPanel?.refreshTracks();
      }
    },
  };
}

(globalThis as unknown as { viewer?: unknown }).viewer = {
  /** 地图与相机位姿内省（headless 冒烟断言用；只读）。 */
  get map() {
    return {
      /** 相机脚底位姿（度）+ 本次地图初始视角来源（未加载地图时 source=null）。 */
      pose: () => {
        const p = fly.getPose();
        return {
          pos: [p.pos[0], p.pos[1], p.pos[2]] as [number, number, number],
          yawDeg: p.ang[0],
          pitchDeg: p.ang[1],
          spawnSource: lastSpawnSource,
        };
      },
      /** 当前地图几何包围盒（GLB 场景 worldBox；无地图 → null）。 */
      mapBox: (): { min: [number, number, number]; max: [number, number, number] } | null =>
        currentBox,
    };
  },
  /** 记录会话（`.replay`）内省 + 播放控制。 */
  get replay() {
    return sessionApi('replay');
  },
  /** 录像会话（`.dem`）内省 + 播放控制。 */
  get demo() {
    return sessionApi('demo');
  },
  /** 当前上场的会话与两侧的就绪情况（切换正确性的只读内省）。 */
  get session() {
    return {
      active: activeKind,
      replay: { active: sessions.replay.isActive, ready: sessions.replay.ready, trackCount: sessions.replay.tracks.length },
      demo: { active: sessions.demo.isActive, ready: sessions.demo.ready, trackCount: sessions.demo.tracks.length },
    };
  },
};

// ── URL 深链：?bsp=&replay=（.replay = Shavit 原生记录；打包部署 / 示例直开）──
async function loadUrlAssets(): Promise<void> {
  const params = new URLSearchParams(window.location.search);
  const bspUrl = params.get('bsp');
  const replayUrl = params.get('replay');
  if (!bspUrl && !replayUrl) return;
  const nameOf = (u: string): string => u.split('/').pop()?.split('?')[0] ?? 'asset';
  try {
    if (bspUrl) {
      const resp = await fetch(bspUrl);
      if (!resp.ok) throw new Error(`BSP → HTTP ${resp.status}（${bspUrl}）`);
      const file = new File([await resp.arrayBuffer()], nameOf(bspUrl));
      await loadBsp(file);
    }
    if (replayUrl) {
      activateTab('replay');
      const resp = await fetch(replayUrl);
      if (!resp.ok) throw new Error(`录像 → HTTP ${resp.status}（${replayUrl}）`);
      // 深链只走 Shavit 原生 .replay：先拿原始字节嗅探（JSON 通道已移除，不按文本读）
      const buf = await resp.arrayBuffer();
      if (!looksLikeShavitReplay(new Uint8Array(buf.slice(0, SHAVIT_SNIFF_BYTES)))) {
        throw new Error(
          `${nameOf(replayUrl)} 不是 Shavit .replay 记录（深链只支持 Shavit 原生 .replay）`,
        );
      }
      await replayPanel?.loadFile(new File([buf], nameOf(replayUrl)));
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[viewer] URL 深链加载失败:', e);
    if (!scene.hasModel()) {
      hud.showGuide();
      hud.showGuideError(`URL 资源加载失败：${msg}`, String(e));
    } else {
      hud.flashStatus(`URL 资源加载失败：${msg}`, 6000);
    }
  }
}
void loadUrlAssets();

// ── 渲染循环 ────────────────────────────────────────────────────────
window.addEventListener('resize', () => scene.resize(gameCanvas));

let lastNow = performance.now();
let hudAt = 0;

/**
 * 自动跟随的「在动」阈值（世界单位，轨道包围盒对角线）：低于它视为挂机实体（花名册的 `moving`）。
 * 录制机器人自己也是一条合法轨道（实测实体 #1 = `ERDY-SURF Recorder`，全程不动），
 * 跟它会得到恒零速度、遥测与按键永不亮 —— 详见帧循环里自动跟随那段的说明。
 */
const MOVING_MIN = 200;

function frame(now: number): void {
  requestAnimationFrame(frame);

  const s = activeSession();

  // ── 录像会话的逐帧看板刷新（**只有它上场时才做**）──
  // 记录会话上场时这里整段不执行：花名册的在线态与名称轮换是录像页自己的事，
  // 不该在记录页白白遍历几十万条采样（本仓夹具曾因此在帧循环里做上千万次浮点运算）。
  if (s.kind === 'demo' && demoPanel) {
    // **名称轮换**：记录机器人沿用同一人物改名显示当前关卡 ⇒ 每帧按当前 tick 刷新玩家行名字。
    demoPanel.refreshNames();
    demoPanel.refreshRoster();
    // **画面左下角的对话浮层**：同一帧里按当前播放头推进（15 秒淡出 / 最多 5 条 / 超出丢最早的）。
    // 只有录像会话上场时才推 —— 记录（`.replay`）没有对话数据，浮层保持空。
    chatOverlay.update(s.player.time);
    // **一次性「跳到这一跑」区间带**（owner：在进度条上把刚跳到的那一段画出来，**过掉就消失**）：
    // 播放头走过区间的末端（+0.2s 容差）就撤掉；还在这一段里（哪怕用户往回拖了一点）就一直留着。
    const jumpSeg = demo.timeline.jumpSpanRange;
    if (jumpSeg && s.player.time > jumpSeg.to + 0.2) demo.timeline.setJumpSpan(null);

    const nowSec = s.player.time;
    const nowTick = Math.round(nowSec * demoPanel.tickRate());

    // ── **按区间把视角绑到「正在看的那个人」此刻那一段**（每帧都做，与播放/暂停、自动跟随开关无关）──
    //
    // owner 定稿：「我只要进入我在看这个人的区间，我就要看到他在这个区间内正在活跃的视角」。
    // 于是判据是**播放头 + 这个人的区间列表**，而不是「刚才跳过一次」这种一次性事件：
    //   · 同一身份可有多段（进服 / 退出 / 再进），**每一段各是一条独立轨迹**（实体号不同）；
    //   · 播放头落进哪一段，视角就绑到**那一段的轨迹**上 —— 手动拖进度条、暂停着看、自动播放，
    //     三种情形一视同仁（早先这段逻辑只写在「自动跟随 + 正在播放」里，于是**暂停时拖到第二段
    //     视角还留在第一段**，owner 实测报的就是这个）；
    //   · 这是**换绑**不是跳转：播放头本来就在这一段里，`jumpTo` 的「区间外才 seek」不会触发，
    //     所以用户的播放位置一动不动（他能随便拖，只是「看谁」跟着段走）。
    if (demoTrackEntity !== null) {
      const seg = demoPanel.spanAt(demoTrackEntity, nowTick);
      if (seg && seg.entity !== demoTrackEntity) {
        autoFollowEntity = seg.entity;
        autoFollowSkippedTo = null; // 他在这一段里确实在场 ⇒ 允许为下一次退出再跳
        autoPickInFlight = true; // 自动换绑不算「用户自己点的」，不解除自动跟随
        demoPanel.pickEntity(seg.entity);
        autoPickInFlight = false;
      }
    }

    // ── 自动跟随视角（owner 定稿的优先级）──
    //
    //   ① **第一位真人的优先级最高**：播放头走到他**在场**的时刻就切到他，并且不再被后进来的机器人抢走；
    //   ② 他**不在场**时（还没进服，或中途退出去了）跟着「此刻真的在动」的那位，至少让观看者有点东西看。
    //
    // 「在场」是**逐段**判断的（`DemoPanel.spanAt`）：真人会进过一次服、退出、又进来，
    // 只看行的并集区间会让他「第一次进场」那一刻就把视角锁在第一段的轨迹上，等到第二段进场也不会切过去。
    //
    // 切人一律走既有 `pickEntity` 路径（建轨道 + 切第一人称），这里只判断"该不该换"。
    // 用户一旦自己点了人，`onClip` 会把 `autoFollow` 置假，不再自动抢视角。
    if (autoFollow && s.player.playing) {
      const roster = demoPanel.roster(0);
      // 第一位真人 = 进场时刻最早、**且本工程采到了位姿**的那位真人（没有人选时为 null）。
      //
      // 判据是 `human`（`userinfo` 里见过**真 guid**）而不是 `!isBot`：录制机器人在观察者录像里从不
      // 更新 `userinfo`，它的 `isBot` 无从判定，拿 `!isBot` 会把**录制机器人**当成第一位真人并一路锁住。
      // `hasTrack` 同样是必须的过滤：花名册也列出「有身份、没采到位姿」的人，对这类人 `pickEntity`
      // 只会弹一句「没有可用位姿」，视角**原地不动**；选成跟随目标会让画面一直卡着不动。
      let firstHuman: { entity: number; from: number } | null = null;
      for (const p of roster) {
        if (!p.human || !p.hasTrack) continue;
        if (!firstHuman || p.from < firstHuman.from) firstHuman = { entity: p.entity, from: p.from };
      }
      // **他现在到底在不在场**（逐段判断，不看行的并集区间）：真人会中途退出又进来。
      const here = firstHuman ? demoPanel.spanAt(firstHuman.entity, nowTick) : null;
      // **我们是不是「一直在看这位真人」**（上一次自动跟的就是他，任一段的实体），
      // 以及**他后面还会不会回来**（下一段的起点）。
      const hisRow = firstHuman ? demoPanel.rosterFor(firstHuman.entity) : null;
      const watchingHim = !!hisRow && autoFollowEntity !== null && hisRow.entities.includes(autoFollowEntity);
      const nextSpan = hisRow ? (hisRow.spans.find((s) => s.from > nowTick) ?? null) : null;
      // **用户自己在动进度条**（拖着滑杆，或刚拖完 0.7 秒内）⇒ 这一帧**什么都不抢**：
      // 不替他跳缺口、也不换去跟机器人 —— 他拖到哪儿就看哪儿（owner 实测：拖到两段中间
      // 被强制弹到第二段开头，就是这里没有让开）。同时把「这次缺口跳过」作废，
      // 免得他松手后下一帧又被弹走；他一旦拖回某一段里（下面的 `here` 分支）这个闸会重置。
      const dragging = demo.timeline.scrubbing || performance.now() - userSeekAt < 700;
      let want: number | null = null;
      if (dragging) {
        if (watchingHim && nextSpan) autoFollowSkippedTo = nextSpan.from;
      } else if (here) {
        want = here.entity; // ① 真人此刻在场 ⇒ 锁定他（的这一段）
        autoFollowSkippedTo = null; // 他回来了 ⇒ 允许为下一次退出再跳
      } else if (watchingHim && hisRow && nextSpan && autoFollowSkippedTo !== nextSpan.from) {
        // ② **他退出了，但我们一直在看他，而且他后面还会回来** ⇒ **不切别人**：
        //    直接把播放头跳到他**重进那一刻**接着看（`pickEntity` → `jumpTo` 发现当前时间在他区间
        //    之外时会 `seek(那一段的起点)`），这样「一直盯着这个人看」的感觉不被打断（owner 定稿）。
        //    同一段只跳一次（`autoFollowSkippedTo`）：手动把播放头拖回缺口时不再被弹走。
        autoFollowSkippedTo = nextSpan.from;
        autoFollowEntity = nextSpan.entity;
        autoPickInFlight = true;
        demoPanel.pickEntity(nextSpan.entity);
        autoPickInFlight = false;
        hud.flashStatus(
          `已跳过 ${hisRow.name} 不在场的一段，接上他重进的 ${fmtClock(demoPanel.secondsAt(nextSpan.from))}`,
          4000,
        );
        want = null; // 已就地处理，跳过下面的通用切换
      } else {
        // ② 真人还没来 ⇒ 跟着「此刻真的在动」的那位，至少有点东西看。
        // **判据只能是运动状态**（实测教训）：记录机器人的四个槽位区间完全相同（都是 0:03–59:57）、
        // 峰值速度也都在 3585~4991，按进场时刻 / 有无名字 / 峰值速度**都分不开**；而某一时刻
        // 只有一个槽位在跑。跟错槽位就会出现「速度读数恒 0、电平表与按键永不亮」。
        // 先只看**当前时刻谁的速度最大**，不加"要有真名"的偏好 ——
        // 实测（t=61/241/421/601/781/961 六个时刻）：静止的 `#1`/`#2` 恒为 0 u/s，
        // 而 `#3`/`#4` 有 397~3293 u/s。加"要有真名"的偏好反而会把 `#3` 排除掉
        // （它的 `nameAtSlot` 在某些 tick 返回空 ⇒ 回退成 `CCSPlayer #3` ⇒ 被判无名），
        // 于是选中静止的 `#2` —— 这正是「按键与电平表永不亮」的最后一道原因。
        const fast = demoPanel.fastestAt(Math.round(nowSec * demoPanel.tickRate()), false);
        if (fast !== null && fast !== autoFollowEntity) {
          autoFollowEntity = fast;
          autoPickInFlight = true; // 自动挑的人不算「用户自己点的」，不解除自动跟随
          demoPanel.pickEntity(fast);
          autoPickInFlight = false;
        }
        want = null; // 已就地处理，跳过下面的通用切换
      }
      if (want !== null && want !== autoFollowEntity) {
        autoFollowEntity = want;
        autoPickInFlight = true;
        demoPanel.pickEntity(want);
        autoPickInFlight = false;
      }
    }
  }

  const dt = Math.min((now - lastNow) / 1000, 0.05); // 帧间隔（秒），上限 50 ms
  lastNow = now;

  // **只有活动会话推进主时钟并刷新 3D 呈现**：另一个会话停表（时间与轨道全部保留）。
  s.tick(dt);

  const sample = s.cameraSample();
  if (sample) {
    // 第一人称：相机完全由该会话驱动（鼠标视角不介入，想自由观察请切第三人称）
    fly.drivesCamera = false;
    fly.allowMove = false;
    // 同步飞行状态（含 roll）：切回第三人称 / 自由飞行时可原地接管
    fly.setWorld(
      { x: sample.pos[0], y: sample.pos[1], z: sample.pos[2] },
      sample.ang[0] * DEG2RAD,
      sample.ang[1] * DEG2RAD,
      sample.ang[2] * DEG2RAD,
    );
    fly.applyToWithRoll(scene.camera);
  } else {
    fly.roll = 0; // 退出回放：清掉 roll 残留，避免自由飞行相机倾斜
    fly.drivesCamera = true;
    fly.allowMove = true;
    fly.update(dt);
    fly.applyTo(scene.camera);
  }

  scene.render();

  if (now - hudAt >= 80) {
    hudAt = now;
    hud.setPose(poseText(fly.getPose()));
    s.timeline.refresh();
    // 遥测 HUD：速度双读数（横向/竖向）+ 按键可视化（跟随轨道当前帧）。
    // 按键只有一条来源：`clip.buttons` 真值。记录（`.replay`）逐帧带真实按键位；
    // 录像（`.dem`）在 `democlip.ts` 里置 `buttons: null` 且**不做任何反推**——Source 引擎
    // 只把录制者本人的输入写进 `dem_usercmd`（观察者/SourceTV 录像实测 0 条），其他玩家的
    // 原始按键不在文件里，由运动学「猜」出来的按键与真实输入存在系统性偏差（owner 裁定
    // 撤除：宁可不显示，也不显示猜的，见 `TODO.md` T-057 / T-060）。
    // 无真值时按键簇整组熄灭；录像会话的时间轴上根本没有按键簇（见 telemetry 构造处）。
    const follow = s.player.tracks.follow;
    const frameButtons = follow?.clip.buttons ?? null;
    const fi = s.player.indexAt(s.player.time);
    telemetry.update(s.player.sample(), frameButtons ? frameButtons[fi] ?? null : null);
  }
}

// 出生点/位姿跳转后立刻刷新一次 HUD
hud.setPose(poseText(fly.getPose()));
// 启动即让记录会话上场（`#session-replay` 在 HTML 里就是 `.active`）
replay.activate();
syncTelemetry();
requestAnimationFrame(frame);

/** 秒 → `m:ss`（与录像时间轴、看板读数同一口径；用于「已跳过…接上他重进的 4:36」这类状态提示）。 */
function fmtClock(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/**
 * 把**面板过滤后**的消息推给画面左下角的浮层（`#chatOverlay`）。
 *
 * 为什么要有这一层：浮层与侧栏「对话」区吃的是**同一份** `DemoParseResult.chat`，
 * 而过滤勾选框在面板上 ⇒ 两边必须同一口径（否则会出现「侧栏滤掉了、浮层还在飘」）。
 * 面板解析失败时（`result === null`）浮层要清空 —— 这一步由 `onParsed` 自己处理，
 * 本函数只在**确实有一份解析产物**时被调用。
 */
function feedChatOverlay(): void {
  if (!demoPanel) {
    chatOverlay.set(null);
    return;
  }
  chatOverlay.set(demoPanel.filteredChat().map((m) => ({ t: demoPanel!.secondsAt(m.tick), text: m.text })));
}

/** 位姿读数行格式化（唯一实现，frame 循环与启动刷新共用）。 */
function poseText(p: Pose): string {  return (
    `pos (${p.pos[0].toFixed(1)}, ${p.pos[1].toFixed(1)}, ${p.pos[2].toFixed(1)})  ` +
    `ang (yaw ${p.ang[0].toFixed(1)}°, pitch ${p.ang[1].toFixed(1)}°)`
  );
}

// ── 关闭确认兜底（Ctrl+W 防误关）─────────────────────────────────────
// 浏览器不允许页面用 keydown preventDefault 拦截 Ctrl+W 这类浏览器快捷键，
// 但 beforeunload 可以：标签页关闭 / 刷新 / 离开前弹**原生确认框**（「离开页面？」，
// 文案由浏览器定、无法自定义；页面需先有过交互才弹——无激活时浏览器直接放行防滥用）。
// 记录 / 录像看到一半误关的页面在这里多一道反悔的机会。
window.addEventListener('beforeunload', (e) => {
  e.preventDefault();
  e.returnValue = ''; // 触发确认框所必需（Chrome/Edge 约定）
});
