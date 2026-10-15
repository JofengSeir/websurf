/**
 * 关闭确认（`beforeunload`）的**唯一判据**（T-056）。
 *
 * 为什么需要：浏览器不允许页面用 `keydown preventDefault` 拦 Ctrl+W，只能靠 `beforeunload` 弹原生
 * 确认框。但**无条件**拦会把「刚打开、什么都没加载」的刷新 / 关闭也拦下来 —— 刷新空页面本来就不丢
 * 东西，多弹一次框纯属噪音（owner 反馈：F5 / 刷新同样弹框）。
 *
 * 判据收敛在这一处，三端只负责把「手里有没有东西可丢」传进来：
 * - `hasMap`：已装载地图（三端都有这一步）；
 * - `hasSession`：viewer 专用 —— 记录 / 录像回放会话进行中（viewer 可以只开记录不开图）。
 *
 * 返回 `true` 时才 `preventDefault()`。本模块**不碰 DOM**（注册与弹框由各端自己做），因此可在
 * Node 侧直接断言真值表。
 */
export interface CloseGuardState {
  /** 已装载地图（三端各自的「当前地图」状态）。 */
  hasMap: boolean;
  /** 记录 / 录像回放会话进行中（仅 viewer 会传）。 */
  hasSession?: boolean;
}

/** 是否该在关闭 / 刷新时弹确认框。 */
export function shouldConfirmClose(state: CloseGuardState): boolean {
  return state.hasMap || state.hasSession === true;
}
