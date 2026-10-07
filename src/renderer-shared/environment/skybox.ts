/**
 * 天空盒（2D cubemap）：把 BSP 的 worldspawn.skyname 与 pakfile 内 6 面 skybox 素材解析成
 * 一组 PNG，并装配成 Three.js 的 CubeTexture 作为 scene.background。
 *
 * 数据来源：BspProcessor.parse_entities()（取 skyname）与
 * BspProcessor.read_pakfile_file('materials/skybox/<skyname><suffix>.vmt') → $basetexture
 * → materials/<base>.vtf → decode_vtf_to_png（由调用方注入）。
 *
 * 轴映射：世界顶点由 `bsp_to_gltf_core` 的 `map_coords` 写成 `[y,z,x]`，渲染端还清掉 GLB 根节点
 * 的 90°Y 旋转 ⇒ Three 轴 = (X←SourceY, Y←SourceZ, Z←SourceX)；Source 六面因此落到 pz/nz/px/nx/py/ny。
 *
 * 边界：只读字节、不联网；PNG 解码与纹理上传在浏览器侧完成（createImageBitmap）。
 */
import * as THREE from 'three';

/** 能提供天空盒素材的 BspProcessor 结构面（debug 的 pkg 满足）。 */
export interface SkyboxProcessorLike {
  parse_entities(): string;
  read_pakfile_file(name: string): Uint8Array;
}

export type SkyboxSlot = 'px' | 'nx' | 'py' | 'ny' | 'pz' | 'nz';

/** CubeTexture 的槽序（three 固定 px,nx,py,ny,pz,nz）。 */
const SLOT_ORDER: readonly SkyboxSlot[] = ['px', 'nx', 'py', 'ny', 'pz', 'nz'];

/** Source 面后缀 → three 槽位（轴映射见文件头）。 */
const SUFFIX_SLOT: ReadonlyArray<readonly [string, SkyboxSlot]> = [
  ['ft', 'pz'],
  ['bk', 'nz'],
  ['lf', 'px'],
  ['rt', 'nx'],
  ['up', 'py'],
  ['dn', 'ny'],
];

/** 极面（up / dn）相对 GL 立方体贴图约定需要**面内旋转**的顺时针 90° 圈数。
 *
 * 依据：六个面两两相邻边的内容连续性实测（相邻边 MAE 显著低于其它配对）——
 * 四个侧面在 `ft→lf→bk→rt` 环序下平均缝差 0.82（错误环序 28~35），极面则必须再各转 90°
 * 才与标准十字布局的相邻关系一致（up 顺时针、dn 逆时针）。
 */
const POLE_TURNS_CW: Partial<Record<SkyboxSlot, number>> = { py: 1, ny: 3 };

export interface SkyboxFacePng {
  slot: SkyboxSlot;
  png: Uint8Array;
}

/** 从 parse_entities() 的 JSON 取 worldspawn.skyname；缺键或空串返回 null。 */
export function skynameFromEntities(entitiesJson: string): string | null {
  try {
    const parsed: unknown = JSON.parse(entitiesJson);
    const list = Array.isArray(parsed)
      ? parsed
      : ((parsed as { entities?: unknown[] }).entities ?? []);
    for (const raw of list as Array<{ classname?: string; props?: Record<string, string> }>) {
      if (raw?.classname === 'worldspawn') {
        const sky = (raw.props?.skyname ?? '').trim();
        return sky.length > 0 ? sky : null;
      }
    }
  } catch {
    // 非法 JSON 只说明没有天空盒，不影响地图渲染
  }
  return null;
}

/** VMT 里第一个 "<key>" "<value>" 的取值；反斜杠归一为斜杠。 */
function vmtValue(text: string, key: string): string | null {
  const pattern = '"' + key.replace(/\$/g, '\\$') + '"\\s+"([^"]+)"';
  const m = new RegExp(pattern, 'i').exec(text);
  return m ? m[1].replace(/\\/g, '/').trim() : null;
}

/**
 * 逐面解析天空盒；任一面（VMT / VTF / 解码）缺失即返回 null —— 不产出半张天空盒。
 * 面后缀与槽位映射见文件头；read_pakfile_file 找不到文件时返回空数组。
 */
export function collectSkyboxFaces(
  proc: SkyboxProcessorLike,
  decodeVtf: (vtf: Uint8Array) => Uint8Array | null,
): SkyboxFacePng[] | null {
  const skyname = skynameFromEntities(proc.parse_entities());
  if (!skyname) return null;
  const read = (p: string): Uint8Array | null => {
    const b = proc.read_pakfile_file(p);
    return b && b.length > 0 ? b : null;
  };
  const decoder = new TextDecoder();
  const faces: SkyboxFacePng[] = [];
  for (const [suffix, slot] of SUFFIX_SLOT) {
    const vmtPath = 'materials/skybox/' + skyname + suffix + '.vmt';
    const vmt = read(vmtPath) ?? read(vmtPath.toLowerCase());
    if (!vmt) return null;
    const base = vmtValue(decoder.decode(vmt), '$basetexture');
    if (!base) return null;
    const vtfPath = 'materials/' + base + '.vtf';
    const vtf = read(vtfPath) ?? read(vtfPath.toLowerCase());
    if (!vtf) return null;
    const png = decodeVtf(vtf);
    if (!png || png.length === 0) return null;
    faces.push({ slot, png });
  }
  return faces;
}

/** 把 6 面 PNG 装配成 CubeTexture（按固定槽序）；面不全或解码失败返回 null。 */
export async function buildSkyboxCubeTexture(
  faces: SkyboxFacePng[] | null | undefined,
): Promise<THREE.CubeTexture | null> {
  if (!faces || faces.length !== 6) return null;
  const bySlot = new Map(faces.map((f) => [f.slot, f.png] as const));
  const images: (ImageBitmap | HTMLCanvasElement)[] = [];
  try {
    for (const slot of SLOT_ORDER) {
      const png = bySlot.get(slot);
      if (!png) return null;
      const bitmap = await createImageBitmap(new Blob([png as BlobPart], { type: 'image/png' }));
      const turns = POLE_TURNS_CW[slot] ?? 0;
      images.push(turns ? rotateBitmap(bitmap, turns) : bitmap);
    }
  } catch {
    return null;
  }
  const texture = new THREE.CubeTexture(images);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;
  return texture;
}


/** 把位图按顺时针 90° 的整数倍转进一张画布（CubeTexture 的六个面源可以是 canvas）。 */
function rotateBitmap(src: ImageBitmap, turnsCw: number): HTMLCanvasElement {
  const swap = turnsCw % 2 !== 0;
  const canvas = document.createElement('canvas');
  canvas.width = swap ? src.height : src.width;
  canvas.height = swap ? src.width : src.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return canvas;
  ctx.translate(canvas.width / 2, canvas.height / 2);
  ctx.rotate((turnsCw * Math.PI) / 2);
  ctx.drawImage(src, -src.width / 2, -src.height / 2);
  return canvas;
}