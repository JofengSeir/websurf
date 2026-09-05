/**
 * 内置默认规则脚本（自家标准格式的映射）。
 *
 * 表单编辑器移除前，这段脚本由 generateScript(defaultRule()) 生成并固化于此——
 * 无 localStorage 规则、深链未带 ?rule= 时，自家格式录像用它直接导入即播。
 * 自家格式的 raw 帧与标准帧**同序**：ang = [yaw, pitch]（直通映射，见 sample.ts）。
 * 契约：scriptSrc 是「求值为 (raw, i, H) => {t, pos[3], ang[3], vel|null} 的单表达式」，
 * 由 compileScript 以 new Function('H', 'return (' + src + ');') 编译。
 */
export const DEFAULT_RULE_SRC = `// 内置默认规则：自家标准格式（pos/ang/vel 直通，tick 128）
// raw  原始帧对象（帧数组里的一个元素）；raw.ang = [yaw, pitch]，与标准帧同序
// i    帧序号（从 0 开始）
// H    H.get(raw, "pos[0]") 取路径  H.num(v) 转数字  H.wrap(度) 归一[0,360)
//      H.clampPitch(度) ±89 限幅  H.deg(弧度) 转度  H.EYE 站立眼高 64.09
(raw, i, H) => {
  const _ix = H.num(H.get(raw, "pos[0]"));
  const _iy = H.num(H.get(raw, "pos[1]"));
  const _iz = H.num(H.get(raw, "pos[2]"));
  const _yaw = H.num(H.get(raw, "ang[0]"));
  const _pitch = H.num(H.get(raw, "ang[1]"));
  const _vx = H.num(H.get(raw, "vel[0]"));
  const _vy = H.num(H.get(raw, "vel[1]"));
  const _vz = H.num(H.get(raw, "vel[2]"));

  return {
    t: i / 128,
    pos: [_ix, _iy, _iz],
    ang: [H.wrap(_yaw), H.clampPitch(_pitch), 0],
    vel: [_vx, _vy, _vz],
  };
}`;
