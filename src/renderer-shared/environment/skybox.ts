/**
 * 天空盒（2D cubemap）：把 BSP 的 worldspawn.skyname 与 pakfile 内 6 面 skybox 素材解析成
 * 一组 PNG，并装配成 Three.js 的 CubeTexture 作为 scene.background。
 *
 * 数据来源：BspProcessor.parse_entities()（取 skyname）与
 * BspProcessor.read_pakfile_file('materials/skybox/<skyname><suffix>.vmt') → $basetexture
 * → materials/<base>.vtf → decode_vtf_to_png（由调用方注入）。
 *
 * 轴映射：导出把 Source 的 [x,y,z] 映射到 Three 的 [y,z,x]（bsp_to_gltf_core 的根旋转），
 * 故 Source 六面 rt/lf/bk/ft/up/dn 落到 Three 的 py/ny/pz/nz/px/nx。
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
  ['up', 'px'],
  ['dn', 'nx'],
  ['rt', 'py'],
  ['lf', 'ny'],
  ['bk', 'pz'],
  ['ft', 'nz'],
];

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
  const images: ImageBitmap[] = [];
  try {
    for (const slot of SLOT_ORDER) {
      const png = bySlot.get(slot);
      if (!png) return null;
      images.push(await createImageBitmap(new Blob([png as BlobPart], { type: 'image/png' })));
    }
  } catch {
    return null;
  }
  const texture = new THREE.CubeTexture(images);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;
  return texture;
}
