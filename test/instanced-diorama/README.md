# instanced-diorama — 实例化绘制 · PBR 光照渲染测试

双模式测试用例：**实例化绘制 + 写实 PBR 材质 + 影棚光照 + SSAO/DOF 电影级后处理**，
并验证 **BSP 光照等更多信息的导出**（`KHR_lights_punctual` 写入 GLB）。

- **沙盘 Diorama**（默认）：2.1 万~10 万实例方块，每材质 1 个 `InstancedMesh` = 1 个 draw call；
  金属（高金属性/低粗糙度/环境反射）、玻璃（透射+折射）、木头/砖块（全漫反射/高粗糙度）物理区分明确。
- **BSP 地图**：拖入 .bsp → wasm 导出**含光照的 GLB**（模型 + `KHR_lights_punctual`）→
  渲染端实例化共享 mesh 节点 + 世界几何合并 → 导出灯光直接照亮场景。

## 快速开始

```bash
npm install
npm run build:wasm    # wasm-pack：BSP 解析/GLB 导出（含光照导出方法）
npm run build:ts      # tsc typecheck + esbuild 打包
python serve.py 8080  # 开发服务器（/maps/ 别名到仓库 maps/）
# 浏览器打开 http://localhost:8080/index.html
```

或一键：`play.cmd`（构建 + 起服务 + 开浏览器）。

## 使用

- **沙盘**：左键旋转 / 右键平移 / 滚轮缩放；面板可调实例数量（2k~100k）、阴影分辨率（2k/4k/8k）、
  曝光、SSAO 强度/半径、DOF 焦点/光圈（默认焦点跟随相机→场景中心 = 移轴"微缩沙盘"效果）、FXAA。
- **BSP 地图**：选择文件或拖拽 .bsp 到窗口；也可 URL 直载 `?bsp=maps/ze_cursed_bear_tales_v1_2.bsp`。
  加载后自动完成：wasm 导出（模型+光照）→ GLTFLoader（原生解析导出灯光）→
  共享 mesh 节点按空间 cell 分组实例化 → 世界几何按材质+cell 合并为静态块。

### 自动化验证参数

| 参数 | 作用 |
|---|---|
| `?bsp=maps/xxx.bsp` | 自动切 BSP 模式并加载 |
| `?ssao=0` / `?dof=0` / `?fxaa=0` | 关闭对应后处理（对照截图） |
| `?lights=N` | 光照预算（默认 32：three.js 前向着色器灯光上限，按亮度取 top-N，Directional 恒保留） |
| `?ambient=1` | 追加环境光兜底 |
| `?probe=1` | 每 4s 把画面下采样为 8×8 亮度网格写入 DOM（无头环境空间诊断） |

## 架构

```
src/
├── main.ts          入口：渲染器（PCFSoft 阴影 / ACES）/ 模式切换 / 面板 / 渲染循环
├── diorama.ts       沙盘：展品区（4 材质行对比）+ 散落区，InstancedMesh 每材质 1 个
├── materials.ts     程序化 PBR 材质（金属/玻璃/木头/砖 + 画布纹理，零外部资源）
├── studio-lights.ts 影棚光照（主平行光 4096 软阴影 + 半球天光 + 补光）
├── composer.ts      后处理：SnapshotPass + SSAO（强度可调合成）+ Bokeh DOF + FXAA + Output
├── instancing.ts    渲染端实例化（共享 mesh → 空间 cell 分组 InstancedMesh）+ 世界几何合并
├── bsp-viewer.ts    BSP 模式：wasm 导出含光照 GLB → 渲染 + 取景 + DOF 焦点对齐
├── hud.ts           FPS / draw calls / 三角形 / 实例数统计（info.autoReset=false 累计整帧）
└── wasm.d.ts        pkg/websurf_wasm.d.ts re-export
crates/wasm/         wasm 层副本（含新增 export_glb_with_pakfile_models_with_lights）
scripts/check-lights.mjs   Node 冒烟：导出 GLB 校验 KHR_lights_punctual / lights / 节点
# （旧 scripts/verify-shot.mjs 截图像素统计判据为本地验证工具：按 **/scripts/verify-*
#   ignore 约定不入库，当前工作区亦不存在；方法与结果见下文「验证记录」）
serve.py             开发服务器（/maps/ 别名）
```

### 光照导出链路（新）

`game/crates/wasm/src/lib.rs`（及本工程副本）新增：

- `collect_light_entities`：BSP 实体中 `light` / `light_spot` / `light_environment` →
  `model_integrator::Entity`（origin/angles/_light/_cone/衰减/pitch 子集）；
- `BspProcessor::export_glb_with_pakfile_models_with_lights`：模型 + 光照 → `KHR_lights_punctual`
  写入 GLB（无模型时仍走 integrator 路径，光照注入照常）。

实测（node 冒烟）：ze（v21）导出 **499 灯**（393 point + 105 spot + 1 directional），
surf_666（v20）导出 **2118 灯**（2061 point + 56 spot + 1 directional）。

## 验证记录（2026-08-14，headless Chrome + SwiftShader）

- **沙盘像素矩阵**：SSAO 开 vs 关（同帧）平均亮度 110.8 → 98.9（遮蔽变暗 ✓）；
  DOF 开 vs 关边缘差 13.9 → 4.4（景深模糊 ✓）；FXAA 关仅边缘差微升（抗锯齿 ✓）。
- **BSP 地图（ze）**：GLB 36.4MB 含 499 灯；实例化 235 组/449 实例；世界几何
  18734 → 787 mesh（503 块）；draw call 55591 → 2376（约 23 倍削减）；导出灯光照亮场景 ✓。
- **BSP 地图（surf_666, v20 CSS）**：GLB 136.5MB 含 2118 灯；实例化 545 组/1013 实例；
  35254 → 2432 mesh（1677 块）。

### 踩坑记录（渲染管线三坑）

1. **EffectComposer 跳过 disabled pass 会破坏 swap 链**：后续 pass 读到陈旧 render target
   （关闭 SSAO 后画面变黑）。解法：不 disable，效果归零（AO 强度=0 / DOF maxblur=0 / FXAA 换 CopyShader）。
2. **ShaderPass 换材质必须同步替换 uniforms 对象**：`render()` 内 `material.uniforms = this.uniforms`
   会覆盖新材质 uniforms（CopyShader 的 opacity 变 0 → 全黑）。
3. **沙盘 Fog（260~900 单位）污染大地图**：BSP 世界尺度下一切被染成雾色（近黑）→ BSP 模式清雾、切回沙盘恢复。

## 已知限制

- BSP 模式 DOF 默认关闭（参数按沙盘尺度调校，世界尺度下全屏模糊；面板可手动开启并调小光圈）。
- 光照预算 top-32 之外的光照被丢弃（three.js 前向着色器上限；forward 渲染下灯越多越贵）。
- SSAO 参数（min/maxDistance 归一化深度）按沙盘相机调校；BSP 大地图下 AO 影响较弱（滑块可调半径/强度）。
