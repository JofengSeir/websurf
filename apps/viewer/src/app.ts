/**
 * WebSurf-viewer — BSP 地图预览 + Shavit `.replay` 回放。
 *
 * 主线程装配：场景 / 飞行相机 / 地图信息 / 出生点导航 / 记录 / 录像导入与回放。本文件是 viewer 的入口
 * （`apps/viewer/package.json` 的 `build:app` 用 esbuild 打成 `web/app.js`）。
 * 定位是**纯视觉**：不引入物理与碰撞，记录与录像只做播放与观察。
 * 播放基准 = 录像帧自身坐标：默认不做起点锚定，坐标映射切换与平移/旋转变换只按用户显式操作叠加。
 * 对外接口 = `globalThis.viewer` 的 `map`（只读内省）与 `replay`（内省 + 播放控制）。
 */

import { DEG2RAD } from './core/constants.js';
import { ViewerScene } from './core/scene.js';
import { FlyCam } from './core/fly.js';
import { resolveInitialSpawn } from './core/spawn.js';
import type { ResolvedSpawn, SpawnSource } from './core/spawn.js';
import type { Pose } from './core/pose.js';
import { humanizeBspError, loadBspFile } from './core/bsp.js';
import type { BspLoadResult } from './core/bsp.js';
import { qs } from './core/dom.js';
import { Hud } from './ui/hud.js';
import { MapPanel } from './ui/mapinfo.js';
import type { WorldBox } from './ui/mapinfo.js';
import { ReplayMetaPanel } from './ui/replaymeta.js';
import { TelemetryHud } from './ui/telemetry.js';
import { ReplayImporter } from './replay/importer.js';
import { ReplayPanel } from './replay/panel.js';
import { DemoPanel } from './replay/demopanel.js';
import { ReplayPlayer } from './replay/player.js';
import { ReplayVisuals } from './replay/visuals.js';
import { Timeline } from './replay/timeline.js';
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
      '可能原因：浏览器禁用了 WebGL / 硬件加速未开启 / 显卡驱动过旧。',
  );
  throw e;
}

const fly = new FlyCam();
fly.attach(gameCanvas);
fly.onLockError = () => hud.flashStatus('鼠标锁定失败，请再点击一次画布重试');

// ── 侧栏与标签页 / 底部 dock（录像信息条 + 时间轴）─────────────────
const sidebarEl = qs('sidebar');
const dockEl = qs('dock');
const timelineEl = qs('timeline');
const telemetryEl = qs('telemetry');
const sidebarToggle = qs<HTMLButtonElement>('sidebarToggle');

sidebarToggle?.addEventListener('click', () => {
  const hidden = sidebarEl?.classList.toggle('hidden') ?? false;
  sidebarToggle.classList.toggle('active', !hidden);
  dockEl?.classList.toggle('full', hidden);
  // 速度 HUD 锚点跟随可视区域：面板收起 → 全屏居中
  telemetryEl?.classList.toggle('full', hidden);
});

for (const tab of Array.from(document.querySelectorAll<HTMLButtonElement>('.tab'))) {
  tab.addEventListener('click', () => {
    const name = tab.dataset.tab;
    if (!name) return;
    for (const t of Array.from(document.querySelectorAll<HTMLButtonElement>('.tab'))) {
      t.classList.toggle('active', t === tab);
    }
    for (const pane of Array.from(document.querySelectorAll<HTMLElement>('.tabpane'))) {
      pane.classList.toggle('active', pane.id === `pane-${name}`);
    }
    if (name === 'replay' && sidebarEl?.classList.contains('hidden')) {
      sidebarEl.classList.remove('hidden');
      sidebarToggle?.classList.add('active');
      timelineEl?.classList.remove('full');
      telemetryEl?.classList.remove('full');
    }
    // **记下当前 tab**：时间轴 / 3D 可视化 / 信息条只喂**当前 tab 自己的轨道**。
    // 两个 tab 共用同一个 `ReplayPlayer` 与同一条底部时间轴，若把两边的轨道一起传过去，
    // 时长取并集、窗口互相覆盖 —— 就是 owner 说的「录像 tab 又和录像 tab 抢进度条组件」。
    activeTab = name === 'demo' ? 'demo' : 'replay';
    // **离开录像 tab 就拆掉录像的播放态**（owner 实测：不拆的话切到「录像」看不了东西）。
    // **只暂停并移除录像轨道，保留 `.dem` 的解析结果** —— 切回来直接可看，不必重读几十 MB。
    if (name !== 'demo') teardownDemo();
    // **进入录像 tab 只做"准备"，绝不删对方的轨道** —— 早先这里把录像的轨道整批 remove 掉，
    // 结果切回「录像」轨迹全没了（owner 实测）。两个 tab 共用 `ReplayPlayer`，但**各自的轨道
    // 属于各自 tab**：录像这边只在需要时增添/替换自己那一条，录像的留给录像。
    else enterDemoTab();
  });
}

/**
 * 进入录像 tab 的准备：恢复录像的时长与布局，并重新开启自动跟随。
 *
 * **不删任何轨道** —— 录像的轨道属于「录像」tab，删掉它就等于毁掉另一边的状态
 * （这正是 owner 报的"录像轨迹切换到录像后就消失了"）。
 * 视频时长用 `player.span` 兜底（`duration = max(tracks.duration, span)`），
 * 录像总长通常远长于任何一条录像片段，故窗口不会被录像的轨道压短。
 */
function enterDemoTab(): void {
  // **先恢复录像的时长与布局，再判断有没有录像轨道**：早先这句 `if (!demoTrackId) return;`
  // 放在最前面 —— 于是"载入后还没选过人"就切走再切回来时，录像模式与 `span` 都不会恢复，
  // 胶片退回 replay 布局、时长也丢了。这两件事与"有没有轨道"无关。
  player.span = demoPanel?.totalSeconds() ?? 0;
  timeline.setDemoMode(true);
  // **跟随目标也要切回录像这条**：否则仍指着「录像」页的轨道，第一人称看的是另一边的数据。
  if (demoTrackId) player.followTrack(demoTrackId);
  syncTracks();
  // 没有录像轨道时也把自动跟随打开：播放头走起来后帧循环会重新挑人并建轨道。
  autoFollow = true;
  autoFollowEntity = null;
}

/**
 * 拆掉录像 tab 的**播放态**（不丢解析结果）。
 *
 * 为什么必须拆：录像轨道与「录像」页共用同一个 `ReplayPlayer` 与 `Timeline`，
 * 录像的 `span`、录像轨道、录像模式与那两条区间带若留着，切到「录像」后
 * 时间轴仍被录像的时长与布局占着，**录像就播不了**（owner 实测）。
 * 保留的是 `demoPanel` 里那份解析结果 —— 切回来不必重新载入 `.dem`。
 */
function teardownDemo(): void {
  if (!demoTrackId) return;
  if (player.playing) player.toggle();
  player.tracks.remove(demoTrackId);
  demoTrackId = null;
  player.span = 0;
  timeline.setDemoMode(false);
  timeline.setActiveSpan(null);
  timeline.setHighlight(null);
  syncTracks();
}

function activateTab(name: string): void {
  document.querySelector<HTMLButtonElement>(`.tab[data-tab="${name}"]`)?.click();
}

// ── 地图信息 / 出生点 ────────────────────────────────────────────────
const mapPane = qs('pane-map');

/** 当前地图包围盒（录像贴合检查用）。 */
let currentBox: WorldBox | null = null;

function applyPose(pose: Pose): void {
  fly.setPose(pose);
}

const mapPanel =
  mapPane &&
  new MapPanel(
    mapPane,
    (pose) => {
      if (replayFirstPerson()) return;
      applyPose(pose);
    },
    // 光照模式（预烘焙 / 纯纹理）：运行期 uniform 切换，不重建场景（与 game/debug 同语义）
    (mode) => scene?.setLightingMode(mode),
  );

// ── 录像 ────────────────────────────────────────────────────────────
const importer = new ReplayImporter();
const player = new ReplayPlayer();
const visuals = new ReplayVisuals(scene);
const replayPane = qs('pane-replay');

/** 轨道增删 / 属性变化后同步：3D 可视化、时间轴、录像信息条、遥测 HUD（轨迹列表由 refreshTracks 负责）。 */
// ── 跨 tab 的状态（**必须声明在 `syncTracks` 之前**）─────────────────────────
// `syncTracks()` 会读这几个变量；若把它们声明在函数之后，启动期一旦有回调触发
// `syncTracks()`，读到的就是尚未初始化的 `let` ⇒ `ReferenceError` ⇒ 页面直接弹致命卡
// （实测：冒烟报 `fatalShown=true`）。
let demoTrackId: string | null = null;
/** 录像轨道当前呈现的**实体号**（取自 `clip.id` 尾段）——改名时用它判断该不该改。 */
let demoTrackEntity: number | null = null;
/** 当前激活的 tab：决定时间轴 / 可视化 / 信息条只看到**哪一边的轨道**。 */
let activeTab: 'replay' | 'demo' = 'replay';
/** **自动跟随视角**：载入后为真 —— 播放头进入谁的活跃区间就切到谁。用户自己点人后置假。 */
let autoFollow = false;
/** 自动跟随当前锁定的实体号（null = 还没锁定）。 */
let autoFollowEntity: number | null = null;
let replayPanel: ReplayPanel | null = null;
function syncTracks(): void {
  // **只把当前 tab 的轨道喂给共用组件**：录像那条用 demoTrackId 认，其余归「录像」页。
  // 两个 tab 的轨道都留在播放器里（切回来不丢），但时间轴/可视化/信息条一次只看一边。
  const tracks = player.tracks.tracks;
  visuals.setTracks(tracks);
  timeline.setTracks(tracks);
  metaPanel.setTracks(tracks, player.tracks.followId);
  telemetry.setTracks(tracks.length > 0);
  // **同步「录像」页自己的轨迹列表**：早先这里没调，于是录像 tab 拆掉轨道（`teardownDemo`）
  // 或录像增删轨道时，录像页那份列表不会跟着变 —— 列表里还挂着已经不存在的轨道。
}


// ── 录像（Source `.dem`） ───────────────────────────────────────────
// 独立于「录像」页：`.dem` 给不出定长位姿，看板是「时间线 + 玩家标注 + 详情」，不复用轨迹列表布局。
const demoPane = qs('pane-demo');

/**
 * 录像的 tick 率：`currentTick` 要把播放秒数换算成 tick 才能查名称时间线。
 * Source 1 引擎（CS:S）固定 **100 tick**，与录像头 `playbackTicks / playbackTime` 的口径一致。
 */
const demoTickRate = 100;
// 录像页自己建的那条轨道 id：点选是「切换看谁」，复用它做替换（见下方 onClip）。
const demoPanel = demoPane
  ? new DemoPanel(demoPane, {
      rule: () => defaultRule(),
      // **名称轮换**：把当前播放位置换算成 tick 交给面板 —— 记录机器人会沿用同一个人物改名显示
      // 当前记录的关卡，故名字必须按 tick 取。`demoTickRate` 来自录像头（默认 100）。
      // **tick 率取录像头的真实值**（总 tick / 总秒数），不能写死：这份录像实际是 66.67 tick，
      // 写死 100 会让「当前 tick」跑快 1.5 倍，播到后半段所有人都被判成离线。
      // 显式标注返回类型：这里引用了正在构造的 demoPanel 自身，否则 TS 推断会成环。
      currentTick: (): number => Math.round(player.time * (demoPanel?.tickRate() ?? 1)),
      // **载入成功就把胶片进度条放出来**：在滑杆上打好进服/换人标记，并让时间轴可见。
      // 早先只有点了某个玩家、建出轨道之后时间轴才出现 —— 载入完那一刻界面像没反应。
      // **悬停看板某一行 ⇒ 在进度条上画出那一行的活跃区间**；移开清除。
      onHoverSpan: (span) => timeline.setHighlight(span),
      // **tick 点按人物切换**：落到录像那条轨道上（isuals 已支持按轨道覆写全局开关）。
      onTickToggle: (_entity: number, on: boolean) => {
        if (demoTrackId) visuals.setTickNodesVisibleFor(demoTrackId, on);
      },
      // **信息条的名字要跟着播放头走**：`.dem` 的记录机器人会把名字改成「当前记录的关卡」，
      // 而信息条显示的是**跟随轨道的名字**（建轨道那一刻定死）⇒ 面板检测到「跟随中那个人」
      // 改名时通知这里：改轨道名 + `syncTracks()` 重渲染信息条（未真变时 rename 返回假，跳过刷新）。
      onWhoName: (entity: number, name: string) => {
        if (!demoTrackId || entity !== demoTrackEntity) return;
        if (player.tracks.rename(demoTrackId, name)) syncTracks();
      },
      onLoaded: () => {
        // **无轨道也能播放/暂停**：把录像总时长写进播放器兜底（否则载入完 play() 直接返回）。
        player.span = demoPanel?.totalSeconds() ?? 0;
        // **录像 tab 换掉 replay 的布局**：收起 A/B 区间、帧步进、帧 · run 读数
        // （那些要么强制定义长度、要么是比较用的精度），时间码改读录像内绝对时刻。
        timeline.setDemoMode(true);
        // **载入完成后从 0s 开始播，并按播放头自动跟随视角**（owner 定稿）：
        // 不预先跳到任何人，而是**播到谁的区间就切到谁** —— 于是先是**最早那位（机器人）**，
        // 再往后**遇到第一位真人**时自动切到真人。`autoFollow` 为真时由帧循环驱动这件事；
        // 用户一旦自己点了人（`onClip`）就置假，不再自动抢视角。
        autoFollow = true;
        player.seek(0);
        player.play();
      },
      // 点选有轨迹的一行 → 建轨道并切第一人称（与「录像」页走同一条 `player.addTrack` 路径）
      // 点选有轨迹的一行 → 建轨道 + 切第一人称 + **立刻播放**
      // （早先只建轨道不播放：视图停在 0 秒不动，看起来像「没反应」——这是「点了没动」的直接原因）
      onClip: (clip) => {
        // **点选是「切换看谁」，不是「再叠一条」**：早先每次点击都 `addTrack`，连点五次就得到五条
        // 轨道（表现为「多次点击会导致创建多个」）。这里记住录像页自己建的那条，后续点击**替换**它。
        // 若那条已被用户删掉（`replaceClip` 返回假），则退回追加。
        autoFollow = false; // 用户自己点了人 ⇒ 不再自动抢视角
        let track: Track | null = demoTrackId ? (player.tracks.tracks.find((t) => t.id === demoTrackId) ?? null) : null;
        if (track && player.tracks.replaceClip(track.id, clip, clip.name)) {
          // 替换成功：沿用原 id
        } else {
          track = player.addTrack(clip);
          demoTrackId = track.id;
        }
        // **给这条录像轨道写上「当前这个人」的颜色**：录像复用同一条轨道（切人只换数据），
        // 轨道色不会自己变，必须由这里按人物写入 —— 否则所有人共用第一个人的颜色。
        // 写入后，3D 里的轨迹线与看板色点取自同一个值（同一张 `TRACK_PALETTE`、同一取模口径）。
        const demEntity = Number(clip.id.split(':').pop());
        demoTrackEntity = demEntity;
        const demColor = demoPanel?.colorFor(demEntity) ?? track.color;
        player.tracks.setColor(track.id, demColor);
        demoPanel?.setTrackColor(demColor);
        player.followTrack(track.id);
        player.mode = 'first';
        syncTracks();
        const start = clip.count > 0 ? clip.t[0] : 0;
        const end = clip.count > 0 ? clip.t[clip.count - 1] : 0;
        // **条上画出「当前视角人物」的活跃区间**，用「录像」页**正式跑段高亮**（`.tl-zone-run`）的同族样式。
        timeline.setActiveSpan(clip.count > 0 ? [start, end] : null);
        // **时间怎么动**（owner 定稿）：
        //   当前时间**在他进服之前** ⇒ 跳到他进服那一刻（否则要空等他几十分钟）；
        //   当前时间**在他活跃区间内** ⇒ **不动时间**，只换视角（这就是「播放期间点击不要回到区间开头重播」）；
        //   当前时间**在他退场之后** ⇒ 跳回他区间的**起点重看**（否则当前时刻他没有画面，点了等于没反应）。
        // **把这个人物自己的 tick 点设置落到轨道上**（每人一份，切人时各自生效）。
        if (demoTrackId) visuals.setTickNodesVisibleFor(demoTrackId, demoPanel?.tickVisibleFor(clip.name ? Number(clip.id.split(':').pop()) : 0) ?? true);
        if (player.time < start || player.time > end) player.seek(start);
        if (!player.playing) player.play();
      },
    })
  : null;

if (replayPane) {
  replayPanel = new ReplayPanel(replayPane, importer, player, {
    onClip: (clip, _warnings, replaceId) => {
      // 改映射/变换后的重新导入 → 替换那条轨道（保留配色/显隐/偏移）；换文件才追加
      let track: Track | null = null;
      if (replaceId && player.tracks.replaceClip(replaceId, clip)) {
        track = player.tracks.tracks.find((t) => t.id === replaceId) ?? null;
      }
      if (!track) track = player.addTrack(clip);
      // 看录像默认第一人称跟随（有轨道后第三人称需手动切回）
      player.mode = 'first';
      syncTracks();
      replayPanel?.refreshTracks();
      updateReplayMapStatus();
      return track.id;
    },
    onClearAll: () => {
      player.clearTracks();
      syncTracks();
      replayPanel?.refreshTracks();
      hud.setReplayStatus('');
    },
    // 轨道属性变化（显隐 / 偏移 / 跟随 / 重命名）：TrackPanel 自己重绘列表，这里重建 3D、时间轴与信息条
    onTracksChanged: () => syncTracks(),
    onStatus: (text) => {
      // 回放域临时消息（导入进度 / 工具结果）走 HUD 提醒行；'' 立即恢复持久内容
      hud.flashReplayStatus(text, 8000);
    },
  });
}

const metaPanel = new ReplayMetaPanel(qs('replayMeta') ?? document.createElement('div'));
const timeline = new Timeline(timelineEl ?? document.createElement('div'), player, visuals);
// 遥测 HUD：速度读数挂顶层 `#telemetry`（定位由 CSS 决定），按键簇挂 `#timeline`（`#dock` 内，随时间轴一起显隐）
const telemetry = new TelemetryHud(
  qs('telemetry') ?? document.createElement('div'),
  timelineEl ?? document.createElement('div'),
);

/**
 * 地图贴合检查，合并成一条 HUD 提醒（只写 `#replayStatus`；用户未必停在录像页，故走跨面提醒）。
 *
 * 判据：某条轨道的 `Clip.bbox` 与当前地图包围盒在**三轴全部**分离、且间隙超过 `pad`（512 HU）
 * 时判「完全落在地图包围盒外」。这通常说明坐标映射选错了（`.replay` 的帧就是自身坐标，
 * 应改录像页的「坐标映射」而不是靠平移把轨迹挪回去）。
 */
function updateReplayMapStatus(): void {
  const tracks = player.tracks.tracks;
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

function replayFirstPerson(): boolean {
  return player.clip !== null && player.mode === 'first';
}

// ── BSP 加载 ────────────────────────────────────────────────────────
const bspFileInput = qs<HTMLInputElement>('bspFile');
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
    await scene.mountGlb(result.glbBytes);

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
// 首访卡按钮不需要 click 转发：它们是 `label[for]`，浏览器原生把点击交给对应 input
// （原先这里挂过一个 `#guideBtn` 监听，那个 id 在页面里不存在，属死链）。

// ── 拖拽：.bsp 加载地图，.replay 载入录像 ───────────────────────────
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
  if (/\.bsp$/i.test(file.name)) {
    void loadBsp(file);
    return;
  }
  if (/\.replay$/i.test(file.name)) {
    // Shavit 原生录像：帧自身坐标直接播放，零配置直入
    activateTab('replay');
    void replayPanel?.loadFile(file);
    return;
  }
  const msg = `未加载：${file.name} 不是 .bsp / .replay（viewer 只支持 Shavit 原生 .replay 录像）`;
  if (!scene.hasModel()) hud.showGuideError(msg);
  else hud.flashStatus(msg, 5000);
});

// ── JS 接口：`globalThis.viewer.map`（只读内省）/ `.replay`（内省 + 播放控制），供外部脚本与 headless 冒烟断言用 ──
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
  get replay() {
    return {
      // 内省字段（只读快照，取值即当前状态）
      trackCount: player.tracks.tracks.length,
      duration: player.duration,
      time: player.time,
      playing: player.playing,
      speed: player.speed,
      mode: player.mode,
      followId: player.tracks.followId,
      /** 场景根(`THREE.Scene`)的子节点数（冒烟断言用）。 */
      sceneObjects: scene.scene.children.length,
      /** 各轨道只读信息（id / 名 / 帧数 / 时长 / 偏移 / 显隐 / 配色 / 首帧坐标）。 */
      tracks: () =>
        player.tracks.tracks.map((t) => ({
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
      /** 跟随轨道的 .replay 头部元信息（Clip.meta；无轨道 / 无元信息 → null）。 */
      meta: () => player.tracks.follow?.clip.meta ?? null,
      // 播放控制（时间单位 = 秒，主时钟；seek 夹到当前区间 [rangeStart, rangeStop]）
      play: () => player.play(),
      pause: () => player.pause(),
      seek: (sec: number) => player.seek(sec),
      setSpeed: (x: number) => {
        player.speed = Math.max(0.1, Math.min(16, Number(x) || 1));
      },
      /** 视角模式：只有 'third' 按第三人称处理，其余入参一律落到 'first'。 */
      setMode: (m: 'first' | 'third') => {
        player.mode = m === 'third' ? 'third' : 'first';
      },
      /** 切换第一人称跟随目标；null = 回到第一条轨道。 */
      follow: (trackId: string | null) => {
        const before = player.tracks.followId;
        if (trackId === null) {
          const t0 = player.tracks.tracks[0];
          if (t0) player.followTrack(t0.id);
        } else {
          player.followTrack(trackId);
        }
        // API 跟随切换与面板 ◎ 按钮同语义：信息条与轨迹列表状态要同步刷新
        // （信息条是事件驱动、只挂在 syncTracks 上；timeline/visuals 每帧自取 follow，无此问题）
        if (player.tracks.followId !== before) {
          syncTracks();
          replayPanel?.refreshTracks();
        }
      },
    };
  },
};


// ── URL 深链：?bsp=&replay=（.replay = Shavit 原生录像；打包部署 / 示例直开）──
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
          `${nameOf(replayUrl)} 不是 Shavit .replay 录像（深链只支持 Shavit 原生 .replay）`,
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

function frame(now: number): void {
  requestAnimationFrame(frame);
  // **名称轮换**：记录机器人沿用同一人物改名显示当前关卡 ⇒ 每帧按当前 tick 刷新玩家行名字。
  if (demoPanel) {
    demoPanel.refreshNames();
    demoPanel.refreshRoster();
    // **自动跟随视角**（owner 定稿的优先级）：
    //
    //   ① **第一位真人的优先级最高**：播放头一走到他进场的时刻，**必须切到他**，
    //      并且此后**锁定在他身上**，不再被后进来的机器人抢走；
    //   ② 真人还没来之前（他可能很久才进服），**跟着"已进场且进场最晚"的那位** ——
    //      通常就是先加载完的机器人 —— 目的是"至少让观看者有点东西看"。
    //
    // 切人一律走既有 `pickEntity` 路径（建轨道 + 切第一人称），这里只判断"该不该换"。
    // 用户一旦自己点了人，`onClip` 会把 `autoFollow` 置假，不再自动抢视角。
    if (autoFollow && player.playing) {
      const nowSec = player.time;
      const totalTicks = Math.max(1, demoPanel.totalTickCount());
      const roster = demoPanel.roster(0);
      const sec = (tk: number): number => (tk / totalTicks) * player.duration;
      // 第一位真人 = 进场时刻最早的那位真人（没有真人时为 null）
      let firstHuman: { entity: number; from: number } | null = null;
      for (const p of roster) {
        if (p.isBot) continue;
        if (!firstHuman || p.from < firstHuman.from) firstHuman = { entity: p.entity, from: p.from };
      }
      let want: number | null = null;
      if (firstHuman && nowSec >= sec(firstHuman.from)) {
        want = firstHuman.entity; // ① 真人已进场 ⇒ 锁定他
      } else {
        // ② 真人还没来 ⇒ 跟着"已进场且进场最晚"的那位，至少有点东西看
        let bestAt = -1;
        for (const p of roster) {
          const at = sec(p.from);
          if (at <= nowSec && at > bestAt) {
            bestAt = at;
            want = p.entity;
          }
        }
      }
      if (want !== null && want !== autoFollowEntity) {
        autoFollowEntity = want;
        demoPanel.pickEntity(want);
      }
    }
  }
  const dt = Math.min((now - lastNow) / 1000, 0.05); // 帧间隔（秒），上限 50 ms
  lastNow = now;

  player.update(dt);
  const sample = player.clip ? player.sample() : null;

  if (replayFirstPerson() && sample) {
    // 第一人称：相机完全由录像驱动（鼠标视角不介入，想自由观察请切第三人称）
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

  // 可视化每帧取**全部**轨道采样（含不可见轨道），显隐由 `apps/viewer/src/replay/visuals.ts` 按 Track.visible 过滤
  visuals.update(player.sampleAll(), player.mode, player.tracks.followId);
  scene.render();

  if (now - hudAt >= 80) {
    hudAt = now;
    hud.setPose(poseText(fly.getPose()));
    timeline.refresh();
    // 遥测 HUD：速度双读数（横向/竖向）+ 按键可视化（跟随轨道当前帧）
    const follow = player.tracks.follow;
    const frameButtons = follow?.clip.buttons ?? null;
    const fi = player.indexAt(player.time);
    telemetry.update(player.sample(), frameButtons ? frameButtons[fi] ?? null : null);
  }
}

// 出生点/位姿跳转后立刻刷新一次 HUD
hud.setPose(poseText(fly.getPose()));
requestAnimationFrame(frame);

/** 位姿读数行格式化（唯一实现，frame 循环与启动刷新共用）。 */
function poseText(p: Pose): string {
  return (
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
