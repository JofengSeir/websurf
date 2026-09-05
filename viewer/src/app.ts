/**
 * WebSurf-viewer — BSP 地图预览 + 录像回放。
 *
 * 主线程装配：场景 / 飞行相机 / 地图信息 / 出生点导航 / 参考显示 / 录像导入与回放。
 * 纯视觉定位：不引入物理与碰撞，录像只做播放与观察。
 */

import { DEG2RAD } from './core/constants.js';
import { ViewerScene } from './core/scene.js';
import { FlyCam } from './core/fly.js';
import { bspYawToCsYaw } from './core/pose.js';
import type { Pose } from './core/pose.js';
import { humanizeBspError, loadBspFile } from './core/bsp.js';
import type { BspLoadResult } from './core/bsp.js';
import { qs } from './core/dom.js';
import { Hud } from './ui/hud.js';
import { MapPanel } from './ui/mapinfo.js';
import type { WorldBox } from './ui/mapinfo.js';
import { ReferenceGrid } from './ui/reference.js';
import { ReplayImporter } from './replay/importer.js';
import { ReplayPanel } from './replay/panel.js';
import type { StartAid } from './replay/panel.js';
import { ReplayPlayer } from './replay/player.js';
import { ReplayVisuals } from './replay/visuals.js';
import { Timeline } from './replay/timeline.js';
import { ruleFromText } from './replay/rule-file.js';
import type { RuleConfig, Track } from './replay/types.js';

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

// ── 侧栏与标签页 ────────────────────────────────────────────────────
const sidebarEl = qs('sidebar');
const timelineEl = qs('timeline');
const sidebarToggle = qs<HTMLButtonElement>('sidebarToggle');

sidebarToggle?.addEventListener('click', () => {
  const hidden = sidebarEl?.classList.toggle('hidden') ?? false;
  sidebarToggle.classList.toggle('active', !hidden);
  timelineEl?.classList.toggle('full', hidden);
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

// ── 地图信息 / 出生点 / 参考显示 ────────────────────────────────────
const mapPane = qs('pane-map');

/** 当前地图包围盒（参考网格 / 录像贴合检查用）。 */
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

const reference = mapPane && new ReferenceGrid(mapPane, scene);

// ── 录像 ────────────────────────────────────────────────────────────
const importer = new ReplayImporter();
const player = new ReplayPlayer();
const visuals = new ReplayVisuals(scene);
const replayPane = qs('pane-replay');

/** 轨道增删 / 属性变化后同步三处：3D 可视化、时间轴、轨迹列表。 */
function syncTracks(): void {
  visuals.setTracks(player.tracks.tracks);
  timeline.setTracks(player.tracks.tracks);
}

let replayPanel: ReplayPanel | null = null;
if (replayPane) {
  replayPanel = new ReplayPanel(replayPane, importer, player, {
    onClip: (clip, _warnings, replaceId) => {
      // 改规则后的重新导入 → 替换那条轨道（保留配色/显隐/偏移）；换文件才追加
      let track: Track | null = null;
      if (replaceId && player.tracks.replaceClip(replaceId, clip)) {
        track = player.tracks.tracks.find((t) => t.id === replaceId) ?? null;
      }
      if (!track) track = player.addTrack(clip);
      // 看录像默认第一人称跟随（有轨道后第三人称需手动切回）
      player.mode = 'first';
      syncTracks();
      replayPanel?.refreshTracks();
      replayPanel?.showClipInfo(clip);
      updateReplayMapStatus();
      replayPanel?.refreshStartAnchor();
      return track.id;
    },
    onClearAll: () => {
      player.clearTracks();
      syncTracks();
      replayPanel?.refreshTracks();
      replayPanel?.refreshStartAnchor();
      hud.setReplayStatus('');
    },
    // 显隐 / 偏移 / 跟随 / 重命名：TrackPanel 自己重绘列表，这里只需重建 3D 与时间轴
    onTracksChanged: () => syncTracks(),
    /** 起点对齐：录像首帧 vs 最近出生点（viewer 世界坐标）。 */
    getStartAid: () => computeStartAid(),
    onStatus: (text) => {
      // 录像域临时消息（导入进度 / 工具结果）走 HUD 提醒行；'' 立即恢复持久内容
      hud.flashReplayStatus(text, 8000);
    },
  });
}

const timeline = new Timeline(timelineEl ?? document.createElement('div'), player, visuals);

/**
 * 地图贴合检查，合并成一条 HUD 提醒（仅 #replayStatus，跨面提醒）。
 *
 * 「轨迹整段落在地图包围盒外」暴露坐标系映射不对，用户可能不在录像页，
 * 所以仍走 HUD；「录像首帧离最近出生点远」的细节与动作指引只保留在
 * 录像页「起点对齐」note（阈值口径统一写进帮助浮层），HUD 不再重复报同因。
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

/**
 * 起点对齐：录像首帧应贴近地图传送起点（出生点）。
 * 取第一条轨道的首帧，找最近的出生点，返回距离与输出坐标平移量；
 * 无地图 / 无录像 / 无出生点时返回 null。
 */
function computeStartAid(): StartAid | null {
  const spawns = mapPanel?.spawnPoints ?? [];
  if (spawns.length === 0 || player.tracks.isEmpty) return null;
  const clip = player.tracks.tracks[0].clip;
  const p0: [number, number, number] = [clip.pos[0], clip.pos[1], clip.pos[2]];
  let best = -1;
  let bestDist = Infinity;
  spawns.forEach((s, i) => {
    const d = Math.hypot(s.pos[0] - p0[0], s.pos[1] - p0[1], s.pos[2] - p0[2]);
    if (d < bestDist) {
      bestDist = d;
      best = i;
    }
  });
  if (best < 0) return null;
  const s = spawns[best];
  return {
    dist: bestDist,
    delta: [s.pos[0] - p0[0], s.pos[1] - p0[1], s.pos[2] - p0[2]],
    spawnName: s.name,
  };
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
    mapPanel?.setMap(result, currentBox);
    reference?.setWorld(currentBox);
    // 地图换了：刷新「起点对齐」检测（录像已载入时这会立刻暴露映射错误）
    replayPanel?.refreshStartAnchor();
    updateReplayMapStatus();

    const glbKb = Math.round(result.glbBytes.byteLength / 1024);
    const spawned = applyInitialPose(result);
    hud.setStatus(
      `${file.name}：${result.meta.magic ?? 'VBSP'}，${result.meta.num_brushes ?? 0} brushes，` +
        `${result.spawnPoints.length} 出生点，GLB ${glbKb} KB${spawned ? '' : '（无出生点，初始视角 = 原点）'}`,
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

/** 初始视角：推荐出生点（外部位姿通道已移除）。返回是否命中出生点。 */
function applyInitialPose(result: BspLoadResult): boolean {
  const points = result.spawnPoints;
  const primary = points[result.primary] ?? points[0];
  if (!primary) return false;
  applyPose({
    pos: [primary.origin?.[0] ?? 0, primary.origin?.[1] ?? 0, primary.origin?.[2] ?? 0],
    ang: [bspYawToCsYaw(primary.angles?.[1] ?? 0), primary.angles?.[0] ?? 0],
  });
  return true;
}

bspFileInput?.addEventListener('change', () => {
  const file = bspFileInput.files?.[0];
  bspFileInput.value = '';
  if (file) void loadBsp(file);
});
guideBtn?.addEventListener('click', () => bspFileInput?.click());

// ── 拖拽：.bsp 加载地图，.json 载入录像 ─────────────────────────────
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
  if (/\.json$/i.test(file.name)) {
    activateTab('replay');
    void replayPanel?.loadFile(file);
    return;
  }
  if (/\.js$/i.test(file.name)) {
    // .js = 规则转化脚本（改规则＝替换当前轨道）
    activateTab('replay');
    void replayPanel?.loadRuleFile(file);
    return;
  }
  const msg = `未加载：${file.name} 不是 .bsp / .json / .js`;
  if (!scene.hasModel()) hud.showGuideError(msg);
  else hud.flashStatus(msg, 5000);
});

// ── JS 接口：window.viewer.replay（只读内省 + 播放控制，外部脚本 / 自动化用）──
(globalThis as unknown as { viewer?: unknown }).viewer = {
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
      /** 各轨道只读信息（id / 名 / 帧数 / 时长 / 偏移 / 显隐 / 配色）。 */
      tracks: () =>
        player.tracks.tracks.map((t) => ({
          id: t.id,
          name: t.name,
          frames: t.clip.count,
          duration: t.clip.duration,
          offset: t.offset,
          visible: t.visible,
          color: t.color,
        })),
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
        if (trackId === null) {
          const t0 = player.tracks.tracks[0];
          if (t0) player.followTrack(t0.id);
          return;
        }
        player.followTrack(trackId);
      },
    };
  },
};


// ── URL 深链：?bsp=&replay=&rule=（打包部署 / 示例直开；相对路径相对页面解析）──
async function loadUrlAssets(): Promise<void> {
  const params = new URLSearchParams(window.location.search);
  const bspUrl = params.get('bsp');
  const replayUrl = params.get('replay');
  const ruleUrl = params.get('rule');
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
      const text = await resp.text();
      let rule: RuleConfig | null = null;
      if (ruleUrl) {
        const rresp = await fetch(ruleUrl);
        if (rresp.ok) {
          // ?rule= 同时接受规则 JSON 与裸 .js 转化脚本（AI 按 docs/replay-rule-ai.md 产出）
          const rf = ruleFromText(await rresp.text(), nameOf(ruleUrl));
          if (rf) rule = rf.rule;
        }
      }
      await replayPanel?.loadUrlContent(text, nameOf(replayUrl), rule);
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
