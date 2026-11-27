/**
 * 水面 GLSL 注入片段（从 ../water.ts 拆出，纯字符串常量，零副作用）。
 *
 * 门禁 `src/scripts/check-shader-anchors.mjs` 递归扫描 shader 目录下所有 .ts（含子目录），
 * 这些片段里的 `#include <...>` 锚点会被计入。改 three 版本或注入锚点时一并核对。
 */

/** 顶点着色器头部：纹理矩阵 uniform + 自定义 varying（不用 three 的 vViewPosition/vNormal）。 */
export const WATER_VERTEX_HEADER =
  'uniform mat4 vbspWaterTextureMatrix;\n' +
  'varying vec3 vbspWaterN;\nvarying vec3 vbspWaterV;\nvarying float vbspWaterDist;\nvarying vec4 vbspWaterMirrorUv;\nvarying vec3 vbspWaterWorld;\n';

/** 顶点着色器 project_vertex 锚点后的注入（世界坐标/法线/视线/视距/镜像 UV）。 */
        export const WATER_VERTEX_PROJECT = [
          '#include <project_vertex>',
          '	vec4 vbspWaterWorld4 = modelMatrix * vec4( transformed, 1.0 );',
          '	vbspWaterWorld = vbspWaterWorld4.xyz;',
          '	vbspWaterN = normalMatrix * normal;',
          '	vbspWaterV = - mvPosition.xyz;',
          '	vbspWaterDist = length( mvPosition.xyz );',
          // 镜像 UV：纹理矩阵**不含 modelMatrix**（共享一张 RT）⇒ 这里自己乘世界矩阵
          '	vbspWaterMirrorUv = vbspWaterTextureMatrix * vbspWaterWorld4;',
        ].join('\n');

/** 片元 uniform 与辅助函数（vbspFrameUv 等），接在 `#include <common>` 之后。 */
    export const WATER_RIPPLE_BLOCK = [
      'uniform float vbspWaterTime;',
      'uniform sampler2D vbspWaterTex;',
      'uniform float vbspWaterWave;',
      'uniform vec3 vbspWaterFog;',
      'uniform float vbspWaterFogStart;',
      'uniform float vbspWaterFogEnd;',
      'uniform float vbspWaterFogMix;',
      'uniform sampler2D vbspWaterMirror;',
      'uniform mat4 vbspWaterTextureMatrix;',
      'uniform float vbspWaterReflOn;',
      'uniform float vbspWaterDistort;',
      'uniform vec3 vbspWaterReflTint;',
      'uniform float vbspWaterReflMix;',
      'uniform float vbspWaterReflStrength;',
      'uniform float vbspWaterDepthGate;',
      'uniform float vbspWaterAlphaFloor;',
      'uniform float vbspWaterAlphaCap;',
      'uniform vec3 vbspWaterBaseColor;',
      'uniform float vbspWaterTintStrength;',
      'uniform float vbspWaterAbsorb;',
      'uniform float vbspWaterAbsorbThickness;',
      'uniform vec3 vbspWaterScatter;',
      'uniform float vbspWaterThickness;',
      'uniform float vbspWaterTransFloor;',
      'uniform float vbspWaterAlphaRef;',
      'uniform float vbspWaterThickLo;',
      'uniform float vbspWaterThickHi;',
      'uniform float vbspWaterDeepMix;',
      'uniform sampler2D vbspWaterSceneDist;',
      'uniform float vbspWaterDepthRange;',
      // ① 折射深度附件（2026-11-17）：跳过第二趟整场景 depth pass，直接用 color RT 的深度。
      // ⚠️ `vbspWaterProjInv` 已在下面「屏幕空间折射」里声明过（同一个 uniform，复用即可），
      // 这里**不能**重复声明 —— 重复声明会让整个水面 shader 编译失败（水面变成灰白错误材质，
      // 静态图与基线差 13% 像素）。
      'uniform sampler2D vbspWaterDepthTex;',
      'uniform float vbspWaterDepthTexOn;',
      'uniform float vbspWaterUseDepthPass;',
      'uniform float vbspWaterFogMax;',
      'uniform float vbspWaterFogCurve;',
      'uniform float vbspWaterFogFloor;',
      'uniform float vbspWaterShoreWidth;',
      'uniform float vbspWaterShoreRefl;',
      'uniform float vbspWaterContentMax;',
      'uniform float vbspWaterNearAlpha;',
      'uniform float vbspWaterFarAlpha;',
      'uniform float vbspWaterBlueStart;',
      'uniform float vbspWaterBlueEnd;',
      // ⚠️ 这两行曾经漏了 `uniform`（写成裸的 `vec2 vbspWaterScroll1;`）⇒ 它们成了**恒为 0 的
      // 全局变量**，GLSL 照样编译通过，只是 `scroll * time` 永远是 0 ⇒ 水面完全静止
      // （实测 `__vbspWaterTime=0` 与 `=100` 逐字节相同）。加 uniform 时务必别漏关键字。
      'uniform vec2 vbspWaterScroll1;',
      'uniform vec2 vbspWaterScroll2;',
      'uniform float vbspWaterRippleScale;',
      'uniform vec2 vbspWaterBumpScale;',
      'uniform float vbspWaterBumpRotate;',
      'uniform sampler2D vbspWaterDudv;',
      'uniform float vbspWaterFrameA;',
      'uniform float vbspWaterFrameB;',
      'uniform float vbspWaterFrameInv;',
      'uniform float vbspWaterFrameMix;',
      'uniform float vbspWaterDudvOn;',
      // 屏幕空间折射（源 `_rt_WaterRefraction` 的对应实现）
      'uniform sampler2D vbspWaterRefr;',
      'uniform float vbspWaterRefrOn;',
      'uniform vec2 vbspWaterScreen;',
      'uniform mat4 vbspWaterProjInv;',
      'uniform mat4 vbspWaterViewInv;',
      'uniform vec3 vbspWaterCamPos;',
      'uniform vec3 vbspWaterRefractTint;',
      'uniform float vbspWaterRefractAmt;',
      'uniform float vbspWaterDepthScale;',
      'uniform vec4 vbspWaterPlanesA;',
      'uniform vec4 vbspWaterPlanesB;',
      'uniform float vbspWaterPlaneCount;',
      'uniform float vbspWaterPatchDepth;',
      'uniform float vbspWaterUsePatchDepth;',
      'uniform float vbspWaterDefaultDepth;',
      'uniform float vbspWaterAbove;',
      'uniform float vbspWaterShadeStrength;',
      'uniform float vbspWaterDebugDepth;',
      'uniform float vbspWaterCanary;',
      // ── T-650 v2 结构优先五规则（R1 雾罩封顶走 FogMax 缺省分流，无新 uniform）──
      'uniform float vbspWaterLift;',
      'uniform float vbspWaterGrazAtt;',
      'uniform float vbspWaterReflCap;',
      'uniform vec3 vbspWaterBeneathFog;',
      'uniform float vbspWaterVoidMode;',
      'uniform float vbspWaterDeepV;',
      'uniform float vbspWaterContentLift;',
      'uniform float vbspWaterR5On;',
      // 图集行坐标：**先 `fract`**（世界 UV 是要平铺的，会到几十的整数倍；不平铺就会取到
      // 图集里别的帧/别的行 ⇒ 水面出现方格、抖动成乱纹、"定格"，2026-10-20 owner 报的方格就是这个），
      // 再把局部 v 压到 1/frames 并抬到第 frame 行。
      // 自己算是因为 three **只对内置贴图槽应用 offset/repeat**，自定义 uniform 采样的贴图不吃变换。
      'vec2 vbspFrameUv( vec2 uv, float frame ) { vec2 t = fract( uv ); return vec2( t.x, t.y * vbspWaterFrameInv + frame ); }',
      'varying vec3 vbspWaterWorld;',
      'varying vec3 vbspWaterN;',
      'varying vec3 vbspWaterV;',
      'varying float vbspWaterDist;',
      'varying vec4 vbspWaterMirrorUv;',
    ].join('\n');

/** 涟漪/折射主体，接在 `#include <envmap_fragment>` 锚点处；与 envBlock 同作用域。 */
    export const WATER_RIPPLE_INJECT = [
      // 注意：**不要**加大括号包起来 —— 下面的反射块要复用这里的变量（同一作用域）。
      //
      // 口径对照 `water_ps2x_helper.h` 的 `DrawWater`：
      // ① 失真图**逐帧换**（`NORMALMAP + BUMPFRAME`，VMT `AnimatedTexture` 30fps）⇒ 这里用
      //    A/B 两帧交叉淡化（去帧跳变），`vbspWaterFrameMix` 由 tick 推进；
      // ② `$scroll1` 一非零就开 `MULTITEXTURE`：`vNormal = 0.33*(vNormal + vNormal1 + vNormal2)`
      //    —— 同一个失真图在**三组不同滚动 UV** 上采样求平均，交叉波面就是这么来的（只平移一层
      //    看起来是"整张图在滑"，owner 指出过）；
      // ③ `vNormal` **只进 `vDependentTexCoords`**（位移折射/反射 UV），不乘进 diffuse。
      // ⚠️ 三组采样坐标必须照抄 SDK 的 `Water_vs20.fxc`（此前写成 uv / uv*1.37 / uv*0.71 —— 全是
      // **同向等比**缩放 ⇒ 叠加出来是"单向等距"的条纹，owner 指出过）：
      //   vBumpTexCoord      = base
      //   f45x = x + y, f45y = y - x                      ← **旋转 45°**
      //   vExtraBumpTexCoord.xy = (f45x, f45y) * 0.1 + scroll1*t   ← 45°、0.1 倍（大尺度涌浪）
      //   vExtraBumpTexCoord.zw = (y, x) * 0.45 + scroll2*t        ← **转置**、0.45 倍（中尺度）
      // 片元再 `0.33 * (n0 + n1 + n2)`：三种尺度/朝向混合，才是各向同性的水波。
      'vec2 vbspWaterDuv = vbspWaterWorld.xz * vbspWaterRippleScale;',
      // 主采样先过 `$bumptransform` 的 scale/rotate（SDK 的 `cBumpTexCoordTransform`）
      'vec2 vbspBase = vec2( vbspWaterDuv.x * vbspWaterBumpScale.x, vbspWaterDuv.y * vbspWaterBumpScale.y );',
      'if ( abs( vbspWaterBumpRotate ) > 0.0001 ) {',
      '	float cs = cos( vbspWaterBumpRotate ); float sn = sin( vbspWaterBumpRotate );',
      '	vbspBase = vec2( vbspBase.x * cs - vbspBase.y * sn, vbspBase.x * sn + vbspBase.y * cs );',
      '}',
      'vec2 vbspF45 = vec2( vbspBase.x + vbspBase.y, vbspBase.y - vbspBase.x );',
      'vec2 vbspUv1 = vbspF45 * 0.1 + vbspWaterScroll1 * vbspWaterTime;',
      'vec2 vbspUv2 = vec2( vbspBase.y, vbspBase.x ) * 0.45 + vbspWaterScroll2 * vbspWaterTime;',
      'vec2 vbspN0 = mix( texture2D( vbspWaterDudv, vbspFrameUv( vbspBase, vbspWaterFrameA ) ).rg, texture2D( vbspWaterDudv, vbspFrameUv( vbspBase, vbspWaterFrameB ) ).rg, vbspWaterFrameMix );',
      'vec2 vbspN1 = mix( texture2D( vbspWaterDudv, vbspFrameUv( vbspUv1, vbspWaterFrameA ) ).rg, texture2D( vbspWaterDudv, vbspFrameUv( vbspUv1, vbspWaterFrameB ) ).rg, vbspWaterFrameMix );',
      'vec2 vbspN2 = mix( texture2D( vbspWaterDudv, vbspFrameUv( vbspUv2, vbspWaterFrameA ) ).rg, texture2D( vbspWaterDudv, vbspFrameUv( vbspUv2, vbspWaterFrameB ) ).rg, vbspWaterFrameMix );',
      'vec2 vbspSlope = ( ( vbspN0 + vbspN1 + vbspN2 ) * 0.3333 - 0.5 ) * 2.0 * vbspWaterDudvOn;',
      // 波纹的**法线着色**：把失真场当高度场求的坡度当法线，打一盏固定方向光（漫射+高光）。
      // 强度由 `vbspWaterShadeStrength` 控制：正常 0.35（压小），
      // `__vbspWaterDebugShade` 时拉到 1（配合 `__vbspWaterOpaque` 单独判断波纹形状像不像水）。
      'vec3 vbspLightDir = normalize( vec3( 0.45, 0.72, 0.53 ) );',
      'vec3 vbspWaveN = normalize( vec3( vbspSlope * 1.7, 1.0 ) );',
      'float vbspDiff = max( dot( vbspWaveN, vbspLightDir ), 0.0 );',
      'float vbspSpec = pow( max( dot( reflect( -vbspLightDir, vbspWaveN ), normalize( vbspWaterV ) ), 0.0 ), 28.0 );',
      'vec3 vbspShaded = diffuseColor.rgb * ( 0.55 + 0.65 * vbspDiff ) + vec3( vbspSpec ) * 0.9;',
      'diffuseColor.rgb = mix( diffuseColor.rgb, vbspShaded, vbspWaterShadeStrength );',
      // ── 水层深度（源：`_rt_WaterRefraction.a`，归一化 0..1）──
      // ⚠️ 必须**先算深度再算位移**：位移公式要用它（水浅位移更小）。此前顺序写反过，
      // 片元编译报 `'vbspWaterDepthValue' : undeclared identifier` ⇒ 水面材质整个不画
      // （2026-10-21 owner 报"水没了"，日志里 `THREE.WebGLProgram: Shader Error` 就是这个）。
      // 优先用**地图自带的 `$waterdepth`**（VBSP 的 depth patch 就是给这个用的）。
      'float vbspDepthRaw = -1.0;',
      'float vbspSceneDist = vbspWaterDist;',
      // ⚠️ 初值**不能是 1.0**（"最深"）：boreas 只有一层水面 ⇒ 找不到下方平面 ⇒ 初值留下 ⇒
      // `$fogcolor` 被混到 95% ⇒ 水面变成一块 #C0C5C7 浅灰（owner 三次报"发白"就是这个）。
      // 拿不到深度时按"浅水"兜底，让折射/基色主导。
      'float vbspWaterDepthValue = vbspWaterDefaultDepth;',
      'if ( vbspWaterUsePatchDepth > 0.5 ) {',
      '	vbspWaterDepthValue = clamp( vbspWaterPatchDepth / vbspWaterDepthScale, 0.0, 1.0 );',
      '} else if ( vbspWaterPlaneCount > 0.5 ) {',
      // 水厚 = 本像素的水面高度 - **它下方最近的那层水面高度**（多面水体积，per-pixel 正确）。
      // 例 surf_666：顶面 -11071、底面 -11968 ⇒ 水厚 897。boreas 只有一层 ⇒ 水厚 0（诚实）。
      '	float vbspLower = -1e9;',
      '	for ( int i = 0; i < 8; i++ ) {',
      '		if ( float( i ) >= vbspWaterPlaneCount ) break;',
      '		float v = i < 4 ? vbspWaterPlanesA[ i ] : vbspWaterPlanesB[ i - 4 ];',
      '		if ( v < vbspWaterWorld.y - 1.0 && v > vbspLower ) vbspLower = v;',
      '	}',
      '	if ( vbspLower > -1e8 ) vbspWaterDepthValue = clamp( ( vbspWaterWorld.y - vbspLower ) / vbspWaterDepthScale, 0.0, 1.0 );',
      '} else if ( vbspWaterRefrOn > 0.5 ) {',
      // 拿不到 `$waterdepth`、也没法从几何推（水面 brush 的上下两面在 BSP 里是同一平面，
      // 实测 boreas 全部水面块都在 y=197）⇒ 用可调的**缺省归一化深度**：
      // 0.35 ⇒ `$fogcolor` 混 0.30、菲涅尔门控已满（以折射为主 + 可见反射）。
      '	vbspWaterDepthValue = vbspWaterDefaultDepth;',
      '}',
      // ── 折射（源 `_rt_WaterRefraction`）：用 DU/DV 位移屏幕 UV 采样"不含水面"的场景 RT ──
      'vec2 vbspScreenUv = gl_FragCoord.xy / vbspWaterScreen;',
      // 源的 `scale *= depthValue`（无 basetexture 分支）：水浅则位移更小。
      // 幅度也要小：owner 反馈"光散过于分散、边缘不该是散点"。
      // R3（T-650 v2）：位移 × att —— 视线越贴近水面（graz→0）位移越收紧，掠射采样
      // 不再飞出水区内容（只动采样坐标，不补偿观感量；暗雾流 grazAtt=1 = 原样）。
      'float vbspGraz = saturate( normalize( cameraPosition - vbspWaterWorld ).y );',
      'vec2 vbspRefrUv = vbspScreenUv + vbspSlope * ( 0.010 * max( 0.25, vbspWaterRefractAmt ) * mix( 0.35, 1.0, vbspWaterDepthValue ) * mix( vbspWaterGrazAtt, 1.0, vbspGraz ) );',
      // 位移采样若落进"没有几何"的区域（RT 背景是黑的），会沿轮廓出现黑边噪点 ⇒
      // 与未位移处比较亮度，明显变暗就回退到未位移样本（常见的 refraction 边缘修正）。
      'vec3 vbspRefrShifted = texture2D( vbspWaterRefr, vbspRefrUv ).rgb;',
      'vec4 vbspRefrBase4 = texture2D( vbspWaterRefr, vbspScreenUv );',
      'vec3 vbspRefrBase = vbspRefrBase4.rgb;',
      'if ( dot( vbspRefrShifted, vec3( 0.3333 ) ) < dot( vbspRefrBase, vec3( 0.3333 ) ) * 0.35 ) { vbspRefrShifted = vbspRefrBase; }',
      // 折射 RT 用**透明黑**清屏：alpha=0 就是“这里没有水下几何”（天空/背景穿透）。
      // 此时不要铺雾色，降低水面 alpha 让主画面的冰/岩透出来；有几何的地方 alpha=1 保持细节。
      // ⚠️ 用 `vbspWaterBaseColor` 这个 **uniform**，不要用 `diffuseColor.rgb`：
      // 水面材质的 `material.color` 在渲染前会被光照/fullbright 那条路按 lightmap 重设
      // ⇒ 我改 `material.color` 的效果全部被覆盖（这就是"改颜色没反应"的根因，
      // 2026-10-21 用金丝雀测试证实：注入确实控制这些像素，但颜色来自被覆盖后的 diffuse）。
      'vec3 vbspRefrColor = vbspWaterRefrOn > 0.5 ? vbspRefrShifted : vbspWaterBaseColor;',
      // T-650 v4 B 线（判定与位移解耦）：`vbspLum0` 必须取**未位移**的 vbspRefrBase——
      // 此前用位移后的 vbspRefrShifted：采样点被噪声推出"有几何"区时亮度骤降 ⇒ NoGeom 翻转
      // ⇒ 精致区边缘被误判成采空，蓝板/结构的分界呈锯齿（owner 实测机位 PS，DudvOff 后分界
      // 变平滑即此故）。位移从此只作用于折射**颜色**采样，有效性判定全部走未位移坐标。
      // ── T-650 v4 W-A2：暗内容曝光提升（d8 定案：黑区=有几何未被照亮，lum<0.02 被误判 NoGeom 平涂）──
      '	float vbspBaseLum = dot( vbspRefrBase, vec3( 0.3333 ) );',
      '	if ( vbspWaterContentLift > 1.0001 ) {',
      '		float vbspDarkness = 1.0 - smoothstep( 0.0, 0.35, vbspBaseLum );',
      '		vbspRefrBase *= 1.0 + ( vbspWaterContentLift - 1.0 ) * vbspDarkness;',
      '	}',
      'float vbspLum0 = dot( vbspRefrBase, vec3( 0.3333 ) );',
      'bool vbspNoGeom = ( vbspRefrBase4.a < 0.5 ) || ( vbspLum0 < 0.02 );',
      'if ( vbspWaterRefrOn > 0.5 && vbspNoGeom ) { vbspRefrColor = vbspWaterScatter; }',
      // ── 竖直深度 + 视线距离（照抄 SDK `common_ps_fxc.h:213-230` 的 `CalcWaterFogAlpha`）──
      //   flDepthFromWater = 水面 y − 命中点 y              ← 竖直深度
      //   f                = saturate(flDepthFromWater / flDepthFromEye)
      //   alpha            = saturate(f * flProjPosZ * 1/fogRange)   ← **还要乘视线距离**
      // 漏掉最后那一项时：远处命中点跑到水面之上 ⇒ 竖直深度取 0 ⇒ 远处反而没有蓝色（owner 报的
      // "距离我越远越看不到蓝色"）。乘上视线距离后，薄膜在掠射远处也会累积成蓝，符合源的表现。
      'float vbspDepthVert = -1.0;',
      'float vbspHitDist = 0.0;',
      // R5（T-650 v2）：真·打空像素标记 = 深度 RT 无效（HEAD 上少量；多层配对命中的像素不会进这分支）。
      'float vbspVoidR5 = 0.0;',
      // v4 A0：有效性提到外层——调试档 7（归因分类）与 A 线 void 判据共用同一 bool。
      'bool vbspDistValid = false;',
      // (a) 有真实水体积：水面层 − 它下方最近的那层（层表，纯竖直差）
      'if ( vbspWaterPlaneCount > 0.5 ) {',
      '	float vbspLower = -1e9;',
      '	for ( int i = 0; i < 8; i++ ) {',
      '		if ( float( i ) >= vbspWaterPlaneCount ) break;',
      '		float v = i < 4 ? vbspWaterPlanesA[ i ] : vbspWaterPlanesB[ i - 4 ];',
      '		if ( v < vbspWaterWorld.y - 1.0 && v > vbspLower ) vbspLower = v;',
      '	}',
      '	if ( vbspLower > -1e8 ) { vbspDepthVert = vbspWaterWorld.y - vbspLower; vbspHitDist = vbspWaterDist; }',
      '}',
      // (b) 零厚度薄膜（如 boreas）：深度 pass 的命中点换回**世界 y**，再取竖直差
      'if ( vbspDepthVert < 0.0 && vbspWaterUseDepthPass > 0.5 && vbspWaterRefrOn > 0.5 ) {',
      '	float vbspSceneDist = 0.0;',
      '	if ( vbspWaterDepthTexOn > 0.5 ) {',
      // ①（2026-11-17）窗口深度 → view 空间点 → 距相机的欧氏距离（与旧 pass 的 length(mv.xyz) 同量纲）。
      // 背景清屏 depth=1 ⇒ 还原点在远平面 ⇒ 距离超量程 ⇒ 判无效（= 旧 24 位 pack 的饱和判定）。
      '		float vbspWDepth = texture2D( vbspWaterDepthTex, vbspScreenUv ).x;',
      '		vec4 vbspViewP = vbspWaterProjInv * vec4( vbspScreenUv * 2.0 - 1.0, vbspWDepth * 2.0 - 1.0, 1.0 );',
      '		vbspSceneDist = length( vbspViewP.xyz / vbspViewP.w );',
      '	} else {',
      '		vec3 vbspDistPack3 = texture2D( vbspWaterSceneDist, vbspScreenUv ).rgb;',
      '		vbspSceneDist = ( vbspDistPack3.r + vbspDistPack3.g / 255.0 + vbspDistPack3.b / 65025.0 ) * vbspWaterDepthRange;',
      '	}',
      // 量程尽头 / 背景 = 没测到。**测不到就按"深水"处理**：远处本来该是蓝的，
      // 不能因为"这一帧没量到"就退化成透明（那会让颜色随站位变化，owner 报的就是这个）。
      '	vbspDistValid = vbspSceneDist > 1.0 && vbspSceneDist < vbspWaterDepthRange * 0.995;',
      '	if ( vbspDistValid ) {',
      '		vec3 vbspRayDir = normalize( vbspWaterWorld.xyz - cameraPosition );',
      '		float vbspHitY = cameraPosition.y + vbspRayDir.y * vbspSceneDist;',
      '		vbspDepthVert = max( 0.0, vbspWaterWorld.y - vbspHitY );',
      '		vbspHitDist = vbspSceneDist;',
      '	} else {',
      '		vbspDepthVert = vbspWaterDepthScale;',
      '		vbspHitDist = max( vbspWaterDist, vbspWaterDepthScale );',
      '		vbspVoidR5 = 1.0;',
      '	}',
      '	vbspVoidR5 *= vbspWaterR5On; // 暗雾流恒 0 = 零改动',
      '}',
      'if ( vbspDepthVert < 0.0 ) vbspDepthVert = 0.0;',
      'if ( vbspHitDist < 1.0 ) vbspHitDist = vbspWaterDist;',
      // 命中点世界 y（体积路径下 = 水面 − 竖直深度，两者一致）
      'float vbspHitY2 = vbspWaterWorld.y - vbspDepthVert;',
      'float vbspDepthFromEye = max( 1.0, cameraPosition.y - vbspHitY2 );',
      'float vbspUnderFrac = clamp( vbspDepthVert / vbspDepthFromEye, 0.0, 1.0 );',
      'float vbspDepthV = clamp( vbspDepthVert / max( 1.0, vbspWaterDepthScale ), 0.0, 1.0 );',
      // 雾量 = **只看竖直深度**（final-b 那版公式，owner 觉得蓝量合适）。
      // 之前那个 `* vbspHitDist`（乘视线距离）会把整片水推成饱和蓝，已删除。
      'float vbspFogAlpha = vbspDepthV;',
      // ── T-650 v4 W-A：深水像素触发集（A0 修正：有效且 depthV ≥ 阈值；模式 0 = 零改动）──
      'float vbspDeepMask = 0.0;',
      '	if ( vbspWaterVoidMode > 0.5 && vbspDistValid && vbspDepthV >= vbspWaterDeepV ) vbspDeepMask = 1.0;',
      '	if ( vbspWaterVoidMode > 1.5 && vbspWaterVoidMode < 2.5 ) {',
      '		vbspFogAlpha = mix( vbspFogAlpha, vbspWaterDeepV, vbspDeepMask );',
      '	}',
      // 折射内容兜底：RT 里没有几何（采到清屏色/纯黑）时，按深度给水色，别给白/黑块。
      'if ( vbspWaterRefrOn > 0.5 && vbspNoGeom ) {',
      '	vbspRefrColor = mix( vbspWaterFog, vbspWaterBaseColor, 0.35 );',
      '}',
      // 折射内容亮度上限：亮冰/亮岩透上来会把水面冲成"白板"（owner：「不要泛太白」）。
      // 按亮度等比压，保色相 —— 只削掉过曝那一截。
      'float vbspLumC = dot( vbspRefrColor, vec3( 0.299, 0.587, 0.114 ) );',
      'vbspRefrColor *= min( 1.0, vbspWaterContentMax / max( vbspLumC, 1e-4 ) );',
      // 源原文：`refract = lerp( refract * tint, $fogcolor, saturate( depth - 0.05 ) )`。
      // 「水底太蓝了，浅一些」⇒ ① `pow` 软化中段（不是线性就冲到满）；② 上限 `fogMax` 不让它饱和成纯蓝。
      // 「稍微白点、近似透明」⇒ 同时给一个**很轻的下限** `fogFloor`：近处不要纯透成亮冰的白，而是
      // 带一点点水色（少量白蓝），近看仍然近似透明。
      'float vbspFogMix = pow( saturate( vbspFogAlpha - 0.05 ), vbspWaterFogCurve );',
      'vbspFogMix = clamp( vbspFogMix, vbspWaterFogFloor, vbspWaterFogMax );',
      'vbspFogMix *= ( 1.0 - vbspVoidR5 ); // R5：打空像素不灌 $fogcolor 雾罩',
      'vbspRefrColor = mix( vbspRefrColor * vbspWaterRefractTint, vbspWaterFog, vbspFogMix );',
      // 深水吸收：雾量越大压得越暗一点，避免远处变成一条发亮的蓝雾带。
      'vbspRefrColor *= mix( 1.0, 0.88, vbspFogMix );',
      // R2（T-650 v2）：折射内容乘性提亮（只作用于已有内容；深水实测 95,145,182 →
      // 目标色调 rgb(120,200,255) 方向；暗雾流 lift=1 = 原样）。
      'vbspRefrColor *= mix( 1.0, vbspWaterLift, saturate( vbspDepthV ) );',
      'diffuseColor.rgb = vbspRefrColor;',
      // ⚠️ **必须同时写 `outgoingLight`**：`<opaque_fragment>` 输出的是 `outgoingLight`，而它在本
      // 材质里由 `reflectedLight.indirectDiffuse` 初始化（lightmap 那套），与 `diffuseColor.rgb`
      // 无关。只写 `diffuseColor.rgb` ⇒ 我算的水色从未上屏（这就是"调了半天颜色没反应"的最后一环，
      // 2026-10-21 用 dump 编译后源码确认）。
      'outgoingLight = vbspRefrColor;',
      // ── 岸边透明带（owner：「岸边全透明只保留反射，离岸才是上面那档透明度」）──
      // 用**竖直深度**当"离岸距离"的代理：岸边水浅（depthVert→0），往里变深。
      //   shoreT=0（岸边）⇒ alpha 只剩反射项 ⇒ 几乎看不见水，只留镜面反射
      //   shoreT=1（离岸）⇒ alpha=1，正常水色（tp-more 那档）
      'float vbspShoreT = smoothstep( 0.0, max( 1.0, vbspWaterShoreWidth ), vbspDepthVert );',
      'float vbspFres0 = pow( clamp( 1.0 - clamp( dot( normalize( vbspWaterN ), normalize( vbspWaterV ) ), 0.0, 1.0 ), 0.0, 1.0 ), 5.0 );',
      'float vbspReflAlpha = clamp( vbspFres0 * vbspWaterReflStrength, 0.0, 1.0 );',
      'if ( vbspWaterRefrOn > 0.5 ) {',
      // 保留 Source 的浅水透明公式，但给一个很低的下限：纯 0 会让涟漪/倒影整层透明掉，
      // 纯 1 又会让水面变成不透明瓷砖、把倒影压掉；0.35 是两种验收症状之间的折中。
      '	diffuseColor.a = max( vbspShoreT, vbspReflAlpha * vbspWaterShoreRefl );',
      '	if ( vbspWaterAlphaFloor > 0.0 ) diffuseColor.a = max( diffuseColor.a, vbspWaterAlphaFloor );',
      '} else {',
      '	diffuseColor.a = mix( vbspWaterNearAlpha, vbspWaterFarAlpha, vbspDepthV );',
      '}',
      // 旧的"按视距混蓝 / 按视线光程吸收 / 按水厚映射"三版已全部删除：
      // 它们的自变量都与"离水面多远"无关，被 owner（2026-10-21 前后）判定为错误方向；
      // 当时的推导文档与深度量程实验只在旧实验线 dev（4f53ea3 / f5d5480），现 main 线未保留。
      // 金丝雀（ripple 段）：这段若没执行，水面不会变品红 ⇒ 区分"注入没进"与"颜色算法不对"。
      'if ( vbspWaterCanary > 0.5 && vbspWaterCanary < 1.5 ) { diffuseColor.rgb = vec3( 1.0, 0.0, 1.0 ); diffuseColor.a = 1.0; }',
    ].join('\n');

/** 菲涅尔反射与雾色混合，复用 rippleInject 里算出的变量。 */
    export const WATER_ENV_BLOCK = [
      // 菲涅尔：照 `DrawWater` —— `fNdotV = saturate(dot(eye, n)); fresnel = pow(1 - fNdotV, 5)`
      '	float vbspFres = pow( clamp( 1.0 - clamp( dot( normalize( vbspWaterN ), normalize( vbspWaterV ) ), 0.0, 1.0 ), 0.0, 1.0 ), 5.0 );',
      // 源的**无 basetexture 分支**：`fFresnel *= saturate((depth - 0.05) * 20)`
      // —— 水浅（水底近）几乎不反射，水深才成镜面。有了折射 RT 的深度就能照抄。
      '	if ( vbspWaterRefrOn > 0.5 && vbspWaterDepthGate > 0.5 ) { vbspFres *= saturate( ( vbspFogAlpha - 0.05 ) * 20.0 ); }',
      // ① three `Water.js` 的平面反射：镜面 UV + 双层滚动法线的扭曲
      '	if ( vbspWaterReflOn > 0.5 ) {',
      '		vec2 vbspMuv = vbspWaterMirrorUv.xy / max( 1e-4, vbspWaterMirrorUv.w );',
      '		vbspMuv = clamp( vbspMuv, vec2( 0.001 ), vec2( 0.999 ) );',
      '		vbspMuv += vbspSlope * vbspWaterDistort;',
      '		vec3 vbspMirror = texture2D( vbspWaterMirror, vbspMuv ).rgb * vbspWaterReflTint;',
      // R4（T-650 v2）：反射混合权重上限（亮雾流 0.25、暗雾流保持 0.40）——反射仍在，只限幅。
      '		float vbspMix = clamp( vbspFres * vbspWaterReflStrength, 0.0, vbspWaterReflCap );',
      '		outgoingLight = mix( outgoingLight, vbspMirror, vbspMix );',
      // 反射越强越不透（Source 的 `lerp(refract, reflect, fresnel)` 同样是替换而不是叠加）
      '		diffuseColor.a = mix( diffuseColor.a, 1.0, vbspMix );',
      '	}',
      '	diffuseColor.a = min( diffuseColor.a, vbspWaterAlphaCap );',
      // 没有水下几何（RT alpha=0）⇒ 水几乎透明，让主画面的冰/岩透出来；
      // 不能铺雾蓝，否则就是 owner 看到的“整片蓝板”。
      'if ( vbspNoGeom ) diffuseColor.a = min( diffuseColor.a, 0.25 );',
      // ② 没有平面反射时退回天空盒 envMap（近白，形同环境光；仅作兜底）
      '	#ifdef USE_ENVMAP',
      '		if ( vbspWaterReflOn < 0.5 ) {',
      '			vec3 vbspReflectVec = reflect( -normalize( vbspWaterV ), normalize( vbspWaterN ) );',
      '			vbspReflectVec = normalize( vbspReflectVec + vec3( vbspSlope * ( vbspWaterWave * 0.35 ), 0.0 ) );',
      '			#ifdef ENVMAP_TYPE_CUBE',
      '				vec4 vbspEnvColor = textureCube( envMap, envMapRotation * vec3( flipEnvMap * vbspReflectVec.x, vbspReflectVec.yz ) );',
      '			#else',
      '				vec4 vbspEnvColor = vec4( 0.0 );',
      '			#endif',
      '			outgoingLight += vbspEnvColor.xyz * reflectivity * vbspFres;',
      '		}',
      '	#endif',
      // 最终"水色收敛"：反射与折射在掠射角都会采到明亮的岩壁/冰面 ⇒ 水面变成灰白板
      // （owner 反复报"发白/不像水"）。这里把最终颜色往**水体色**拉一把，保证任何角度都读出
      // "青绿的水"，同时保留折射/反射带来的明暗层次（只是被水色统一）。
      // 注意：必须改 `outgoingLight`（`<opaque_fragment>` 用的是它；写 `diffuseColor.rgb`
      // 在这之后不会被采纳 —— 第一版就踩了这个，画面完全没变化）。
      // 涟漪法线着色必须**在反射/折射之后**再混一层：只改 diffuseColor 会被后面的
      // mirror/refr 覆盖，平墙反射时看起来完全没有波纹（owner 2026-10-24 报“连涟漪都消失”）。
      '	outgoingLight = mix( outgoingLight, vbspShaded, clamp( vbspWaterShadeStrength * 0.5, 0.0, 1.0 ) );',
      '	outgoingLight = mix( outgoingLight, vbspWaterBaseColor, vbspWaterTintStrength );',
      // ── T-650 v4 W-A 档 1/3：深水像素的后合成覆盖（模式 0/2 不进此分支）──
      '	if ( vbspDeepMask > 0.5 && vbspWaterVoidMode < 1.5 ) {',
      // 档 1 天空镜面：丢弃暗内容输出平面反射（对照项，预期非主选）
      '		vec2 vbspMirrorMuv = clamp( vbspWaterMirrorUv.xy / max( 1e-4, vbspWaterMirrorUv.w ), vec2( 0.001 ), vec2( 0.999 ) );',
      '		outgoingLight = texture2D( vbspWaterMirror, vbspMirrorMuv ).rgb;',
      '		diffuseColor.a = 1.0;',
      '	} else if ( vbspDeepMask > 0.5 && vbspWaterVoidMode > 2.5 ) {',
      // 档 3 深渊暗色：真实内容向 beneath 深色收敛（内容保留型）
      '		outgoingLight = mix( outgoingLight, vbspWaterBeneathFog, 0.85 );',
      '		diffuseColor.a = 1.0;',
      '	}',
      // R5（T-650 v2）：真·打空像素的安静回落——向 beneath 深色收敛（beneathDeep 取 beneath
      // 材质 $fogcolor 解析原值按线性使用，实测样例 (10,39,67)；缺省退本材质 fog×0.25），
      // alpha 提到 1（不漏主画面）；命中像素 vbspVoidR5=0 完全不受影响。
      '	if ( vbspVoidR5 > 0.5 ) {',
      '		outgoingLight = mix( outgoingLight, vbspWaterBeneathFog, 0.85 );',
      '		diffuseColor.a = 1.0;',
      '	}',
      // 调试：`__vbspWaterDebugDepth` 时把中间量直接输出成颜色（R=raw depth, G=厚度/深度尺度,
      // B=视距/深度尺度），用来**量化**深度还原到底错在哪（不靠肉眼猜）。
      '	if ( vbspWaterCanary > 1.5 ) {',
      // 金丝雀：强制纯红不透明。确认"我改的到底是不是屏幕上的水"。
      // 用 2 这个值（而不是 1）以便与 ripple 段的品红金丝雀区分开：1=品红（只在 ripple 段）、
      // 2=红（只在 env 段）—— 两段都会执行，后执行的会盖掉先执行的，所以必须分开取值。
      '		outgoingLight = vec3( 1.0, 0.0, 0.0 );',
      '		diffuseColor.a = 1.0;',
      '	} else if ( vbspWaterDebugDepth > 1.5 && vbspWaterDebugDepth < 2.5 ) {',
      // 2 = 常量绿：验证调试分支确实被执行（若屏幕没变绿 ⇒ 分支没进/被后续 fog 覆盖）
      '		outgoingLight = vec3( 0.0, 1.0, 0.0 );',
      '		diffuseColor.a = 1.0;',
      '	} else if ( vbspWaterDebugDepth > 7.5 ) {',
      // 8 = 折射 RT 未位移采样的通道分解：R=RT alpha（0=空 1=有渲染），G=内容亮度×5，B=0。
      // 定「黑区」身份：R 低 ⇒ RT 里根本没渲染（空）；R 高 G 低 ⇒ 有渲染但近黑（未照亮内容）。
      '		outgoingLight = vec3( vbspRefrBase4.a, vbspLum0 * 5.0, 0.0 );',
      '		diffuseColor.a = 1.0;',
      '	} else if ( vbspWaterDebugDepth > 6.5 ) {',
      // 7 = v4 A0 归因分类：R=深度RT有效性（未位移判定），G=归一化竖直深度，B=NoGeom。
      // 配合档 2（水面像素纯绿掩码）即可逐像素分类蓝板：「真·无几何」vs「有几何但雾顶格」。
      '		outgoingLight = vec3( vbspDistValid ? 1.0 : 0.0, saturate( vbspDepthV ), vbspNoGeom ? 1.0 : 0.0 );',
      '		diffuseColor.a = 1.0;',
      '	} else if ( vbspWaterDebugDepth > 5.5 ) {',
      // 6 = 直接输出镜像 RT：确认“水下的反射图”本身是什么；放射/空洞/整片单色都在这里看
      '		vec2 vbspDbgMuv = clamp( vbspWaterMirrorUv.xy / max( 1e-4, vbspWaterMirrorUv.w ), vec2( 0.001 ), vec2( 0.999 ) );',
      '		outgoingLight = texture2D( vbspWaterMirror, vbspDbgMuv ).rgb;',
      '		diffuseColor.a = 1.0;',
      '	} else if ( vbspWaterDebugDepth > 4.5 ) {',
      // 5 = **雾量场** `vbspFogAlpha`（0=透明，1=最深/最蓝）：与着色同量，分箱统计才有意义
      '		outgoingLight = vec3( vbspFogAlpha );',
      '		diffuseColor.a = 1.0;',
      '	} else if ( vbspWaterDebugDepth > 3.5 ) {',
      // 4 = 直接输出折射 RT（未位移）⇒ 一眼看清"RT 里到底剩了什么"
      '		outgoingLight = texture2D( vbspWaterRefr, vbspScreenUv ).rgb;',
      '		diffuseColor.a = 1.0;',
      '	} else if ( vbspWaterDebugDepth > 2.5 ) {',
      // 3 = 把时间/滚动/位移直接画出来：R=time/4, G=fract(uv1.x), B=length(slope)
      '		outgoingLight = vec3( vbspWaterTime / 4.0, fract( vbspUv1.x ), length( vbspSlope ) );',
      '		diffuseColor.a = 1.0;',
      '	} else if ( vbspWaterDebugDepth > 0.5 ) {',
      '		outgoingLight = vec3( vbspDepthRaw, vbspWaterDepthValue, clamp( vbspWaterDist / vbspWaterDepthScale, 0.0, 1.0 ) );',
      '		diffuseColor.a = 1.0;',
      '	}',
    ].join('\n');
