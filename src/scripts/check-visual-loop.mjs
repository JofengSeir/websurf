#!/usr/bin/env node
/**
 * 三端视觉线契约门禁：输入回调只准入队，视觉更新必须由计算/呈现循环消费。
 *
 * 背景（2026-11-26）：game 的视觉线曾在 feedInput 里直接改 viewYaw/viewPitch，
 * owner 明确要求「输入回调不解耦，视觉更新要始终以最快频率产出」。修复后 game 用
 * stepVisual 在计算步消费；debug 的 pendingDx 由 1000Hz presentation.step 消费；
 * viewer 的 mouseDx 由 rAF 的 FlyCam.update 消费。三端形状不同（game 有 64tick
 * 权威物理、debug 有 1000Hz 预测、viewer 只有飞相机），但契约相同：
 *
 *   1. mousemove/feedInput 里不得直接写相机位姿/视角；
 *   2. 视角增量必须只入队；
 *   3. 视角必须在各端最快的循环里消费（game/debug：计算步；viewer：渲染帧）。
 *
 * 本脚本把这三条写成可执行判据，防止以后又把「事件驱动视角」加回来。
 * 只读源码，不依赖 wasm / node_modules / 地图夹具。违规 exit 1。
 *
 * 用法：node src/scripts/check-visual-loop.mjs [--root <dir>]
 *   --root 只给反向对照样本用：指向别的目录时按同一规则扫描该目录。
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const argv = process.argv.slice(2);
const arg = (name, def) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
};
const ROOT = resolve(arg('--root', process.cwd()));

const GAME = 'apps/game/src/renderer/renderer-main.ts';
const DEBUG = 'apps/debug/src/renderer/renderer-main.ts';
const VIEWER_FLY = 'apps/viewer/src/core/fly.ts';
const VIEWER_APP = 'apps/viewer/src/app.ts';

/** 把注释与字符串内容抹成空格，只留下可判读的代码标识符。 */
function codeOnly(source) {
  let out = '';
  let i = 0;
  while (i < source.length) {
    const c = source[i];
    const n = source[i + 1];
    if (c === '/' && n === '/') {
      while (i < source.length && source[i] !== '\n') i++;
      out += '\n';
      continue;
    }
    if (c === '/' && n === '*') {
      i += 2;
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) i++;
      i += 2;
      out += ' ';
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      const quote = c;
      i++;
      while (i < source.length) {
        if (source[i] === '\\') {
          i += 2;
          continue;
        }
        if (source[i] === quote) {
          i++;
          break;
        }
        i++;
      }
      out += '""';
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** 从 marker 起找到第一个代码块 {…}，按字符串/注释/嵌套花括号配对，返回块内文本。 */
function bodyAfter(source, marker) {
  const at = source.indexOf(marker);
  if (at < 0) throw new Error('找不到标记：' + marker);
  let i = source.indexOf('{', at + marker.length);
  if (i < 0) throw new Error('标记后没有代码块：' + marker);
  const start = i + 1;
  let depth = 1;
  i++;
  while (i < source.length && depth > 0) {
    const c = source[i];
    const n = source[i + 1];
    if (c === '/' && n === '/') {
      while (i < source.length && source[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && n === '*') {
      i += 2;
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      const quote = c;
      i++;
      while (i < source.length) {
        if (source[i] === '\\') {
          i += 2;
          continue;
        }
        if (source[i] === quote) {
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    if (c === '{') depth++;
    else if (c === '}') depth--;
    i++;
  }
  if (depth !== 0) throw new Error('代码块没有闭合：' + marker);
  return source.slice(start, i - 1);
}

const CHECKS = [
  {
    file: GAME,
    marker: 'feedInput(dx: number, dy: number, keysMask: number): void',
    label: 'game feedInput 只入队',
    require: ['this.viewDx += dx', 'this.viewDy += dy', 'this.pendingDx += dx'],
    forbid: ['viewYaw', 'viewPitch', 'updateCamera(', 'camera.rotation', 'camera.position'],
  },
  {
    file: GAME,
    marker: 'private stepVisual(now: number): void',
    label: 'game stepVisual 在计算步消费视觉增量',
    require: ['this.viewYaw -= dx * M_YAW', 'this.viewPitch =', 'this.updateCamera(now)'],
    forbid: ['this.pendingDx', 'this.pendingDy'],
  },
  {
    file: GAME,
    marker: 'private stepFixedSimulation(dt: number): void',
    label: 'game 计算步先推进视觉线',
    require: ['this.stepVisual(now)'],
    forbid: [],
  },
  {
    file: DEBUG,
    marker: 'feedInput(dx: number, dy: number, keysMask: number): void',
    label: 'debug feedInput 只入队',
    require: ['this.pendingDx += dx', 'this.pendingDy += dy'],
    forbid: ['cameraController', 'setYawPitch', 'updateCamera(', 'camera.rotation'],
  },
  {
    file: DEBUG,
    marker: 'private stepFixedSimulation(dt: number): void',
    label: 'debug 计算步消费输入并摆相机',
    require: ['this.presentation?.step(dt)'],
    forbid: [],
  },
  {
    file: VIEWER_FLY,
    marker: "window.addEventListener('mousemove'",
    label: 'viewer mousemove 只入队',
    require: ['this.mouseDx +=', 'this.mouseDy +='],
    forbid: ['this.yaw', 'this.pitch', 'this.update('],
  },
  {
    file: VIEWER_FLY,
    marker: 'update(dt: number): void',
    label: 'viewer 每帧消费鼠标增量',
    require: ['this.yaw -= dx * MOUSE_SENS', 'this.pitch ='],
    forbid: [],
  },
  {
    file: VIEWER_APP,
    marker: 'fly.update(dt);',
    label: 'viewer rAF 帧循环调用 FlyCam.update',
    require: ['fly.update(dt);'],
    forbid: [],
    noBody: true,
  },
];

function lineOf(source, index) {
  return source.slice(0, index).split('\n').length;
}

let failed = 0;
const seen = new Set();
for (const check of CHECKS) {
  const file = join(ROOT, check.file);
  let source;
  try {
    source = readFileSync(file, 'utf8');
  } catch {
    console.error('[FAIL] ' + check.file + ' 读不到（' + check.label + '）');
    failed++;
    continue;
  }
  seen.add(check.file);
  try {
    const markerAt = source.indexOf(check.marker);
    if (markerAt < 0) throw new Error('找不到标记：' + check.marker);
    const body = check.noBody
      ? codeOnly(source)
      : codeOnly(bodyAfter(source, check.marker));
    for (const needle of check.require) {
      if (!body.includes(needle)) {
        console.error(
          '[FAIL] ' + check.file + ':' + lineOf(source, markerAt) + ' ' + check.label +
          ' — 缺少契约代码：' + needle,
        );
        failed++;
      }
    }
    for (const needle of check.forbid) {
      if (body.includes(needle)) {
        console.error(
          '[FAIL] ' + check.file + ':' + lineOf(source, markerAt) + ' ' + check.label +
          ' — 输入/视觉职责越界：' + needle,
        );
        failed++;
      }
    }
  } catch (err) {
    console.error('[FAIL] ' + check.file + ' ' + check.label + ' — ' + err.message);
    failed++;
  }
}

if (failed > 0) {
  console.error('\n[visual-loop] ' + failed + ' 项违规：输入回调不得直接改相机；视角增量必须在计算/呈现循环里消费。');
  process.exit(1);
}

console.log(
  '[visual-loop] OK — ' + CHECKS.length + ' 条判据 / ' + seen.size + ' 个文件：' +
  'game stepVisual 计算步消费、debug presentation.step 计算步消费、viewer rAF FlyCam.update 消费。',
);
