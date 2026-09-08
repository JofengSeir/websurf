/**
 * WebSurf-viewer — BSP 地图预览 + 录像回放。
 *
 * 主线程装配：场景 / 飞行相机 / 地图信息 / 出生点导航 / 录像导入与回放。
 * 纯视觉定位：不引入物理与碰撞，录像只做播放与观察。
 * 播放基准 = .replay 帧自身坐标（t4）：无强制起点锚定；平移/映射切换仅显式叠加。
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
import { ReplayImporter } from './replay/importer.js';
import { ReplayPanel } from './replay/panel.js';
import { ReplayPlayer } from './replay/player.js';
import { ReplayVisuals } from './replay/visuals.js';
import { Timeline } from './replay/timeline.js';
import { looksLikeShavitReplay, SHAVIT_SNIFF_BYTES } from './replay/shavit-replay.js';
import type { Track } from './replay/types.js';

const canvas = document.getElementById('game') as HTMLCanvasElement | null;
if (!canvas) throw new Error('canvas#game 未找到');
const gameCanvas: HTMLCanvasElement = canvas;

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
const sidebarToggle = qs<HTMLButtonElement>('sidebarToggle');

sidebarToggle?.addEventListener('click', () => {
  const hidden = sidebarEl?.classList.toggle('hidden') ?? false;
  sidebarToggle.classList.toggle('active', !hidden);
  dockEl?.classList.toggle('full', hidden);
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
    }
  });
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
  new MapPanel(mapPane, (pose) => {
    if (replayFirstPerson()) return;
    applyPose(pose);
  });

// ── 录像 ────────────────────────────────────────────────────────────
const importer = new ReplayImporter();
const player = new ReplayPlayer();
const visuals = new ReplayVisuals(scene);
const replayPane = qs('pane-replay');

/** 轨道增删 / 属性变化后同步：3D 可视化、时间轴、录像信息条（轨迹列表由 refreshTracks 负责）。 */
function syncTracks(): void {
  const tracks = player.tracks.tracks;
  visuals.setTracks(tracks);
  timeline.setTracks(tracks);
  metaPanel.setTracks(tracks, player.tracks.followId);
}

let replayPanel: ReplayPanel | null = null;
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
      // 录像域临时消息（导入进度 / 工具结果）走 HUD 提醒行；'' 立即恢复持久内容
      hud.flashReplayStatus(text, 8000);
    },
  });
}

const metaPanel = new ReplayMetaPanel(qs('replayMeta') ?? document.createElement('div'));
const timeline = new Timeline(timelineEl ?? document.createElement('div'), player, visuals);

/**
 * 地图贴合检查，合并成一条 HUD 提醒（仅 #replayStatus，跨面提醒）。
 *
 * 「轨迹整段落在地图包围盒外」暴露坐标系映射不对（t4 基准=帧自身坐标，正确的
 * .replay 若触发此提醒应修「坐标映射」切换而不是平移锚定），用户可能不在录像页，
 * 所以仍走 HUD，细节指引在录像页「坐标映射」分区。
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
const guideBtn = qs<HTMLButtonElement>('guideBtn');

let bspLoading = false;

/** 加载中：引导按钮 / 地图页「更换地图」都进 busy 态。 */
function setLoadBusy(busy: boolean): void {
  guideBtn?.classList.toggle('busy', busy);
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
    // 初始视角回退解析（P2-4）需要几何 bbox，须在 worldBox 之后；
    // 面板 ★ 推荐标记与初始视角同源（resolveInitialSpawn 单点）。
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
 * 应用初始视角（P2-4 回退策略，resolveInitialSpawn 单点解析：
 * spawn 实体 → bbox 内传送目标 → bbox 中心高位俯瞰）。
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
guideBtn?.addEventListener('click', () => bspFileInput?.click());

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

// ── JS 接口：window.viewer.replay / window.viewer.map（只读内省 + 播放控制，外部脚本 / 自动化用）──
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
      // 内省
      trackCount: player.tracks.tracks.length,
      duration: player.duration,
      time: player.time,
      playing: player.playing,
      speed: player.speed,
      mode: player.mode,
      followId: player.tracks.followId,
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
      // 播放控制（时间单位 = 秒，主时钟；seek 会被 A-B 区间夹取）
      play: () => player.play(),
      pause: () => player.pause(),
      seek: (sec: number) => player.seek(sec),
      setSpeed: (x: number) => {
        player.speed = Math.max(0.1, Math.min(16, Number(x) || 1));
      },
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
  const dt = Math.min((now - lastNow) / 1000, 0.05);
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

  visuals.update(player.sampleAll(), player.mode, player.tracks.followId);
  scene.render();

  if (now - hudAt >= 80) {
    hudAt = now;
    hud.setPose(poseText(fly.getPose()));
    timeline.refresh();
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
