/**
 * 离线烘焙静态光照的 three.js 侧落地：RGBExp32 图集解码着色器注入 + prop 三级光照路由。
 *
 * ## 归属
 *
 * 渲染共享层 `src/renderer-shared/` 的单实例（2026-10-02 起由三工程各自 `src/renderer/` 下的
 * 三份同构副本合并而来，旧副本已删除）。三工程经 tsconfig include 跨目录收编本文件，
 * import 走深层相对路径；行为与合并前的 game 版本一致（三份副本本就逐字节相同）。
 *
 * ## 上游（Rust/wasm 侧产出 GLB）
 *
 * - `src/wasm-core/bsp_to_gltf_core/lightmap.rs` 的 `build_atlas` 把 VRAD 烘焙结果打成一页
 *   RGBA8 图集；`inject_lightmap_json` 把纹理下标写进 `asset.extras.lightmap.textureIndex`；
 *   `lightmap_uv` 把每个顶点映射到图集内缩矩形（min 加半像素、size 取矩形边长减一）。
 * - `src/wasm-core/bsp_to_gltf_core/convert.rs` 把该 UV 写进 `TEXCOORD_1`，并按面写图元
 *   `extras.hasLightmap`（未命中图集区域的面写中性常量 UV）。
 * - `src/wasm-core/model_integrator/mod.rs` 给 prop 写逐顶点烘焙属性 `_VBSP_VLIGHT`
 *   （glTF 自定义语义，运行期键名见 `VERTEX_LIGHTING_ATTR`）与 node extras 的 `ambientCube`。
 *
 * ## 下游（本文件的消费点）
 *
 * - `apps/game/src/renderer/renderer-main.ts`：`loadLightmapAtlas` → `applyLightmapToMeshes`
 *   → `fullbrightUnlitLitMaterials`，并读注入记录字段做统计。
 * - `apps/debug/src/renderer/renderer-main.ts`：只调 `loadLightmapAtlas` / `applyLightmapToMeshes`
 *   与 `setLightingMode` / `getLightingMode`，不做装配后终扫。
 * - `apps/viewer/src/core/scene.ts`：`loadLightmapAtlas` / `applyLightmapToMeshes` /
 *   `fullbrightUnlitLitMaterials`，传入的是模型根 Group 而非 `THREE.Scene`。
 *
 * ## 三条光照路径（都在片元里替换 three 的 lightmap 采样项）
 *
 * 1. **world 面**：图集 + 手写双线性 + RGBExp32 解码，函数体在 `VBSP_APPLY_LIGHTMAP`；
 * 2. **prop 第 1 级**：几何属性 `_VBSP_VLIGHT` 的逐顶点烘焙值 **加上**同顶点的 leaf ambient cube 项（`_VBSP_VCUBE`；`direct + indirect`，D-016 口径）；
 * 3. **prop 第 2 级**：几何**没有** `_VBSP_VLIGHT` 时的回退——node extras 的 leaf ambient cube，按法线平方加权（`applyAmbientCubeIfAny`）。
 *
 * `extras.unlit === true` 的图元不吃任何光照，直接贴图原色（`routeFullbright` 的首个分支）。
 *
 * ## 关键不变量
 *
 * - 图集纹理必须 `NoColorSpace` + `NearestFilter` + 不生成 mipmap：RGBExp32 的指数在 α 通道上，
 *   硬件插值会先混指数再解码。双线性只在 `vbsp_ApplyLightmap` 里对**已解码**的值做。
 * - 解码式：`exp = alpha * 255 - 128`、`rgb_linear = rgb * 2^exp`；rgb 是线性辐射度，
 *   不做 `pow(1/2.2)`，显示变换由 `installGamma22Output` 统一在出口做一次。
 * - lightMap 槽的 UV 由 `Texture.channel` 决定（three r151+ 起），必须显式置 1 才读 `uv1`，
 *   否则回落到 `uv`（漫反射 UV），见 `resolveLightmapUvChannel`。
 * - γ 只作用于**光照项**，不作用于 `albedo × 光照` 的乘积：注入后片元值为
 *   `albedo_linear × 光照项`，出口再整体做 `^(1/2.2)`；若把 `^(1/2.2)` 挪到乘积上，
 *   暗部会被额外压低一个量级（三条路径同此口径）。
 * - 注入材质用到的贴图槽固定为 `map`、`lightMap`、`alphaMap`（后者由
 *   `copyMaterialRenderState` 从原材质继承，可为空），不新增其它纹理槽。
 * - `uniform` 声明只有 `VBSP_LIGHTMAP_UNIFORM_DECLS` / `VBSP_AMBIENT_UNIFORM_DECLS` 两个来源，
 *   三条注入路径都从它们取；缺一条声明就是 GLSL 编译失败、整批 mesh 不绘制。
 * - 图元 `extras.hasLightmap === false` 表示只有中性占位 UV（无真实 luxel），
 *   此时不施加 lightmap，改走 fullbright，避免用无意义 UV 采到图集里别的面。
 *
 * ## 失败语义
 *
 * - `injectLightmapShader` 的两条替换通道都没命中时，除 `broken` 阶段外一律置
 *   `globalThis.__vbspLightmapInjectFailed = true` 并 `throw`，使调用方非零退出。
 * - `applyVertexLightingShader` / `applyAmbientCubeIfAny` 锚点失配时只 `console.error`
 *   并把结果记在材质的注入记录字段上，渲染继续（fullbright 兜底）。
 * - `loadLightmapAtlas` 在缺少 `textureIndex` 或加载（`parser.loadTexture`）失败时
 *   返回 `null`；调用方在 `null` 时整段跳过 lightmap 施加，地图仍是贴图原色。
 *
 * ## 副作用
 *
 * 模块被 import 时即调用 `installGamma22Output()` 覆盖 three 的 `colorspace_fragment` 块，
 * 早于任何材质编译；该覆盖是全局的、幂等的，可用 `globalThis.__vbspOutputGamma22 === false` 关闭。
 */

export {
  VBSP_DECOMPRESS_LIGHTMAP_SAMPLE,
  VBSP_APPLY_LIGHTMAP,
  VBSP_LIGHTMAP_UNIFORM_DECLS,
  VBSP_AMBIENT_UNIFORM_DECLS,
  VERTEX_LIGHTING_ATTR,
} from './lightmap/glsl-chunks.js';

export { smoothVertexLighting } from './lightmap/vertex-lighting.js';

export { setSpotScale, setSpotLights, setDLights } from './lightmap/dynamic-lights.js';
export type { SpotLightInput, DLightInput } from './lightmap/dynamic-lights.js';

export {
  installGamma22Output,
  readLightmapStage,
  LIGHTMAP_UV_CHANNEL_CORRECT,
  resolveLightmapUvChannel,
  loadLightmapAtlas,
  applyLightmapToMeshes,
  fullbrightUnlitLitMaterials,
} from './lightmap/material-patch.js';
export type { LightmapStage } from './lightmap/material-patch.js';

export {
  setVhvLinear,
  getVhvLinear,
  setLightingMode,
  getLightingMode,
  LIGHTING_PRESENTATION_DEFAULTS,
  applyLightingPresentationDefaults,
  setLightFloor,
  setLightGamma,
  getLightGamma,
  setExposure,
  setAmbientScale,
  setFogMaxDensity,
  setReflectionEnvMap,
  getReflectionEnvMapState,
} from './lightmap/state.js';
export type { LightingMode } from './lightmap/state.js';
