/**
 * mini — 统一配置（框架参数单一来源）
 *
 * 所有可调参数集中于此，主线程 createConfig() 后经 init 消息注入两个 Worker。
 * 改参数只需改这里（或 createConfig(overrides) 覆盖）——业务代码零硬编码。
 *
 * 用法：
 *   const cfg = createConfig({ phys: { moveSpeed: 500 }, render: { fov: 90 } });
 *   workerA.postMessage({ type: 'init-shared', shared, config: cfg });
 */

/** 深度合并（递归处理嵌套对象，最多 3 层：顶层 / phys·render·input·target / 其子对象如 keyMap）。 */
function merge(base, overrides) {
  if (!overrides) return base;
  const out = { ...base };
  for (const [k, v] of Object.entries(overrides)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object') {
      out[k] = merge(base[k], v); // 递归：keyMap 等二级嵌套可局部覆盖
    } else {
      out[k] = v;
    }
  }
  return out;
}

/**
 * 创建默认配置（可覆盖）。
 * @param {object} overrides 局部覆盖（示例：{ phys: { gravity: 1000 }, render: { fov: 90 } }）
 * @returns {object} 完整配置
 */
export function createConfig(overrides = {}) {
  const base = {
    // ── 物理（WorkerA）──────────────────────────────
    phys: {
      renderDt: 0.001, // 无限制子步（s）——1ms 与完整版一致
      maxStepsPerRound: 8, // 每轮子步上限（防无限追赶）
      maxDelta: 0.05, // 单帧 delta 钳制（s）
      maxAcc: 0.02, // 累积器封顶（s）
      maxInputDelta: 1000, // 输入限幅（防穿墙）
      moveSpeed: 240, // 平面最大速度（u/s）
      accel: 1200, // 平面加速度（u/s²）
      gravity: 800, // 重力（u/s²）
      jumpVel: 260, // 跳跃初速（u/s）
      sensitivity: 0.08, // 鼠标灵敏度（度/像素）
      pitchClamp: 89, // 俯仰角钳制（度，±）
      tickAnchorDist: 64, // tick 分叉锚定距离（u）
      backpressureThresholdMs: 1, // 背压：距下次子步 ≥ 此值（ms）才挂起 WAKEUP
      backpressureMaxMs: 4, // 背压单次最长休眠（ms；限制 respawn 等消息最坏延迟）
      tickRate: 64, // 初始 tick 率（模式B；0 = 纯无限制）——运行时经 SAB 槽切换
    },

    // ── 渲染（WorkerB）──────────────────────────────
    render: {
      fov: 73.6, // 视野（度）
      near: 0.1, // 近裁剪面
      far: 5000, // 远裁剪面
      eyeStand: 64, // 相机眼高（u）
      bgColor: [0.06, 0.08, 0.12], // 背景色 RGB
      gridHalfLines: 40, // 网格半线数（N×N 格，步长 gridStep）
      gridStep: 100, // 网格步长（u）
      gridColor: [0.35, 0.4, 0.5], // 网格线颜色
      boxHalfSize: 100, // 参考方块半边长（u）
      boxColor: [0.9, 0.25, 0.2], // 参考方块颜色
      renderTimeoutMs: 50, // 帧信号超时兜底（ms）
    },

    // ── 输入（main）────────────────────────────────
    input: {
      // 键位映射：动作 → KeyboardEvent.code
      keyMap: {
        forward: 'KeyW',
        backward: 'KeyS',
        left: 'KeyA',
        right: 'KeyD',
        jump: 'Space',
        respawn: 'KeyR',
      },
    },

    // ── 目标（验证脚本参考；生产忽略——rAF 跟随显示器刷新率）────
    target: {
      refreshHz: 0, // 验证脚本声明目标刷新率（生产 main 不读取；真实刷新由浏览器 rAF 决定）
    },
  };
  return merge(base, overrides);
}
