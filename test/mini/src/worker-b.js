/**
 * mini — WorkerB 渲染循环（架构与 test/src/worker-b.ts 一致，场景用原生 WebGL 简单网格）
 *
 * 架构对齐点（mini 保留完整版核心结构）：
 * - OffscreenCanvas：transferControlToOffscreen 后控制权归本线程（零拷贝直通合成器）
 * - 帧信号驱动：waitRenderWakeup(RENDER_WAKEUP 计数语义) —— 主驱动 = 主线程 rAF（vsync 对齐）；
 *   超时兜底自驱；渲染后 absorbRenderWake 吸收渲染期间信号（防忙循环超限）
 * - 渲染参数唯一来源 = readState（WorkerA 物理真理源；V 更新才读新槽）
 * - **插值渲染**（2026-08-12 修复）：物理发布 ~50Hz 而渲染 = 刷新率时，两状态间
 *   线性插值相机位置/角度 → 观感 = 刷新率；yaw 最短路径环绕 + 归一化 [-180,180)
 * - 本地副本只被 readState 更新（渲染参数零污染）；插值结果用独立 renderState
 *
 * **全部可调参数来自 init 消息携带的 config（src/config.js 单一来源）**——
 * FOV/裁剪面/眼高/场景颜色/网格尺寸/超时等零硬编码。
 */

import { TestShared } from './shared-state.js';

let shared = null;
let R = null; // config.render 参数集（init 后注入）
let gl = null;
let canvas = null;
let camera = { yaw: 0, pitch: 0, pos: { x: 0, y: 0, z: 0 } };
let proj = new Float32Array(16);
let view = new Float32Array(16);
let gridBuffer = null;
let gridCount = 0;
let boxBuffer = null;
let boxCount = 0;

// ── 插值窗口（与 worker-b.ts 一致）──
let interpLast = null;
let interpLastT = 0;
let interpCur = null;
let interpCurT = 0;
let localCopy = null; // 权威渲染参数源（只被 readState 更新）

const stats = { frames: 0, repaints: 0, fps: 0, repaintSec: 0, t0: performance.now() };

let RENDER_TIMEOUT_MS = 50;
const resumeChannel = new MessageChannel();

// ── 最小 WebGL 管线（单色线段场景）─────────────────────────────
const VS = `
attribute vec3 aPos;
uniform mat4 uMVP;
void main() { gl_Position = uMVP * vec4(aPos, 1.0); }
`;
const FS = `
precision mediump float;
uniform vec3 uColor;
void main() { gl_FragColor = vec4(uColor, 1.0); }
`;

let progGrid = null;
let progBox = null;

function compileShader(type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    throw new Error('shader: ' + gl.getShaderInfoLog(s));
  }
  return s;
}
function makeProgram(vs, fs) {
  const p = gl.createProgram();
  gl.attachShader(p, compileShader(gl.VERTEX_SHADER, vs));
  gl.attachShader(p, compileShader(gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  return p;
}
function buildGrid() {
  // 网格（config.render.gridHalfLines × gridStep 步长）
  const pts = [];
  const N = R.gridHalfLines;
  const step = R.gridStep;
  for (let i = -N; i <= N; i++) {
    const c = i * step;
    pts.push(c, 0, -N * step, c, 0, N * step);
    pts.push(-N * step, 0, c, N * step, 0, c);
  }
  gridCount = pts.length / 3;
  gridBuffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, gridBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(pts), gl.STATIC_DRAW);
}
function buildBox() {
  // 参考立方体（config.render.boxHalfSize；底面贴地）
  const s = R.boxHalfSize;
  const y = s;
  const pts = [];
  const addFace = (a, b, c, d) => {
    pts.push(...a, ...b, ...c, ...c, ...d, ...a);
  };
  addFace([-s, y + s, -s], [s, y + s, -s], [s, y + s, s], [-s, y + s, s]);
  addFace([-s, y - s, -s], [s, y - s, -s], [s, y - s, s], [-s, y - s, s]);
  addFace([-s, y - s, s], [s, y - s, s], [s, y + s, s], [-s, y + s, s]);
  addFace([-s, y - s, -s], [s, y - s, -s], [s, y + s, -s], [-s, y + s, -s]);
  addFace([-s, y - s, -s], [-s, y - s, s], [-s, y + s, s], [-s, y + s, -s]);
  addFace([s, y - s, -s], [s, y - s, s], [s, y + s, s], [s, y + s, -s]);
  boxCount = pts.length / 3;
  boxBuffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, boxBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(pts), gl.STATIC_DRAW);
}

// ── 矩阵工具（透视 + 视图）─────────────────────────────────────
function perspective(out, fovDeg, aspect, near, far) {
  const f = 1 / Math.tan((fovDeg * Math.PI) / 360);
  out.fill(0);
  out[0] = f / aspect;
  out[5] = f;
  out[10] = (far + near) / (near - far);
  out[11] = -1;
  out[14] = (2 * far * near) / (near - far);
}
function lookAt(out, ex, ey, ez, cx, cy, cz, ux, uy, uz) {
  let zx = ex - cx, zy = ey - cy, zz = ez - cz;
  let l = Math.hypot(zx, zy, zz);
  zx /= l; zy /= l; zz /= l;
  let xx = uy * zz - uz * zy;
  let xy = uz * zx - ux * zz;
  let xz = ux * zy - uy * zx;
  l = Math.hypot(xx, xy, xz);
  xx /= l; xy /= l; xz /= l;
  const yx = zy * xz - zz * xy;
  const yy = zz * xx - zx * xz;
  const yz = zx * xy - zy * xx;
  out.fill(0);
  out[0] = xx; out[1] = yx; out[2] = zx;
  out[4] = xy; out[5] = yy; out[6] = zy;
  out[8] = xz; out[9] = yz; out[10] = zz;
  out[12] = -(xx * ex + xy * ey + xz * ez);
  out[13] = -(yx * ex + yy * ey + yz * ez);
  out[14] = -(zx * ex + zy * ey + zz * ez);
  out[15] = 1;
}
function mul(out, a, b) {
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 4; j++) {
      out[i * 4 + j] = a[i * 4] * b[j] + a[i * 4 + 1] * b[4 + j] + a[i * 4 + 2] * b[8 + j] + a[i * 4 + 3] * b[12 + j];
    }
  }
}

// ── 渲染 ──────────────────────────────────────────────────────
function draw() {
  const w = canvas.width;
  const h = canvas.height;
  gl.viewport(0, 0, w, h);
  const [br, bg, bb] = R.bgColor;
  gl.clearColor(br, bg, bb, 1);
  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
  gl.enable(gl.DEPTH_TEST);

  const aspect = w / Math.max(h, 1);
  perspective(proj, R.fov, aspect, R.near, R.far);
  // 相机 = 插值状态 pos + 眼高，yaw/pitch 映射（'YXZ' 欧拉 → 视线）
  const cy = camera.pos.y + R.eyeStand;
  const yawRad = (camera.yaw * Math.PI) / 180;
  const pitchRad = (camera.pitch * Math.PI) / 180;
  const dx = -Math.sin(yawRad) * Math.cos(pitchRad);
  const dy = Math.sin(pitchRad);
  const dz = -Math.cos(yawRad) * Math.cos(pitchRad);
  const eye = [camera.pos.x, cy, camera.pos.z];
  const target = [camera.pos.x + dx, cy + dy, camera.pos.z + dz];
  lookAt(view, eye[0], eye[1], eye[2], target[0], target[1], target[2], 0, 1, 0);

  const mvp = new Float32Array(16);
  mul(mvp, proj, view);

  // 网格地面（config.render.gridColor）
  gl.useProgram(progGrid);
  gl.bindBuffer(gl.ARRAY_BUFFER, gridBuffer);
  const aPos = gl.getAttribLocation(progGrid, 'aPos');
  gl.enableVertexAttribArray(aPos);
  gl.vertexAttribPointer(aPos, 3, gl.FLOAT, false, 0, 0);
  gl.uniformMatrix4fv(gl.getUniformLocation(progGrid, 'uMVP'), false, mvp);
  gl.uniform3f(gl.getUniformLocation(progGrid, 'uColor'), R.gridColor[0], R.gridColor[1], R.gridColor[2]);
  gl.drawArrays(gl.LINES, 0, gridCount);

  // 参考方块（config.render.boxColor）
  gl.useProgram(progBox);
  gl.bindBuffer(gl.ARRAY_BUFFER, boxBuffer);
  const aPosB = gl.getAttribLocation(progBox, 'aPos');
  gl.enableVertexAttribArray(aPosB);
  gl.vertexAttribPointer(aPosB, 3, gl.FLOAT, false, 0, 0);
  gl.uniformMatrix4fv(gl.getUniformLocation(progBox, 'uMVP'), false, mvp);
  gl.uniform3f(gl.getUniformLocation(progBox, 'uColor'), R.boxColor[0], R.boxColor[1], R.boxColor[2]);
  gl.drawArrays(gl.LINES, 0, boxCount);
}

// ── 帧循环（与 worker-b.ts 一致）───────────────────────────────
function frameTick() {
  try {
    return onFrame();
  } catch (err) {
    console.error('[mini worker-b] 渲染帧异常（已跳过）:', err);
    return false;
  }
}

resumeChannel.port1.onmessage = () => {
  let repainted = false;
  if (shared && gl) {
    shared.waitRenderWakeup(RENDER_TIMEOUT_MS);
    repainted = frameTick();
    shared.absorbRenderWake();
  }
  resumeChannel.port2.postMessage(null);
};

function onFrame() {
  const now = performance.now();
  const state = shared.readState();
  if (state) {
    if (interpCur) {
      interpLast = interpCur;
      interpLastT = interpCurT;
    } else {
      interpLast = null;
      interpLastT = 0;
    }
    interpCur = state;
    interpCurT = now;
    localCopy = state;
    stats.repaints++;
  }
  if (!localCopy || !interpCur) return false;

  // 插值渲染参数（独立 renderState，不污染 localCopy 权威语义）
  let rs;
  if (interpLast && interpCurT > interpLastT) {
    const span = interpCurT - interpLastT;
    const alpha = Math.min(Math.max((now - interpLastT) / span, 0), 1);
    rs = interpolateState(interpLast, interpCur, alpha);
  } else {
    rs = interpCur;
  }
  camera.pos = rs.pos;
  camera.yaw = rs.yaw;
  camera.pitch = rs.pitch;
  stats.frames++;
  draw();
  updateStats();
  return true;
}

/** 两状态线性插值（yaw 最短路径 + 归一化 [-180,180)）。 */
function interpolateState(a, b, alpha) {
  let dy = (b.yaw - a.yaw) % 360;
  if (dy > 180) dy -= 360;
  else if (dy < -180) dy += 360;
  const yaw = ((a.yaw + dy * alpha + 180) % 360 + 360) % 360 - 180;
  return {
    pos: {
      x: a.pos.x + (b.pos.x - a.pos.x) * alpha,
      y: a.pos.y + (b.pos.y - a.pos.y) * alpha,
      z: a.pos.z + (b.pos.z - a.pos.z) * alpha,
    },
    yaw,
    pitch: a.pitch + (b.pitch - a.pitch) * alpha,
    v: b.v,
  };
}

/** 统计（每秒一次，帧循环自计时）。 */
function updateStats() {
  const now = performance.now();
  if (now - stats.t0 < 1000) return;
  const fps = Math.round((stats.frames * 1000) / (now - stats.t0));
  const repaintSec = Math.round((stats.repaints * 1000) / (now - stats.t0));
  stats.frames = 0;
  stats.repaints = 0;
  stats.fps = fps;
  stats.repaintSec = repaintSec;
  stats.t0 = now;
  self.postMessage({
    type: 'status',
    fps,
    repaintSec,
    pos: localCopy ? localCopy.pos : null,
    yaw: localCopy ? localCopy.yaw : null,
    pitch: localCopy ? localCopy.pitch : null,
    v: localCopy ? localCopy.v : -1,
  });
}

// ── 握手（config 随 init 注入）─────────────────────────────────
self.addEventListener('message', (e) => {
  const msg = e.data;
  switch (msg.type) {
    case 'init-shared':
      shared = TestShared.initRender(msg.shared);
      if (msg.config?.render) {
        R = msg.config.render;
        RENDER_TIMEOUT_MS = R.renderTimeoutMs ?? 50;
      }
      break;
    case 'init-canvas':
      canvas = msg.canvas;
      gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
      if (!gl) {
        self.postMessage({ type: 'error', message: 'WebGL 不可用' });
        return;
      }
      progGrid = makeProgram(VS, FS);
      progBox = makeProgram(VS, FS);
      buildGrid();
      buildBox();
      resumeChannel.port2.postMessage(null); // 自驱启动帧循环
      break;
    case 'resize':
      // 更新画布像素尺寸（OffscreenCanvas 无样式，setSize 改 buffer）+ viewport
      if (gl && canvas) {
        canvas.width = Math.max(1, Math.round(msg.width));
        canvas.height = Math.max(1, Math.round(msg.height));
        gl.viewport(0, 0, canvas.width, canvas.height);
      }
      break;
  }
});
