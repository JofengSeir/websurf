/**
 * VTF 原生 DXT1 / DXT3 / DXT5（BC1 / BC2 / BC3）压缩纹理直通加载器与 CPU 回退解码器。
 *
 * 1. Rust 端把 VTF 压缩块直接打包为 `VDXT` 载荷（`mimeType = "application/x-vbsp-dxt"`），
 *    跳过 CPU 解压与 PNG 编码。
 * 2. 浏览器支持 `WEBGL_compressed_texture_s3tc` 且支持 `WEBGL_compressed_texture_s3tc_srgb` 时，
 *    直接构造 `THREE.CompressedTexture` 上传 GPU（VRAM 降 4x-8x，零 PNG 解码 / 零 generateMipmap）。
 * 3. 若任一扩展缺失（或设置了 `__vbspDxtCpuFallback = true`），无缝在 JS 解压 mip 0 为
 *    `THREE.DataTexture(RGBAFormat)`。
 */
import * as THREE from 'three';
import type { GLTFLoader, GLTFParser } from 'three/examples/jsm/loaders/GLTFLoader.js';

export const VDXT_MIME = 'application/x-vbsp-dxt';
export const VDXT_HEADER_BYTES = 16;

export type VdxtFormat = 1 | 2 | 3 | 5;

export interface DxtCapabilities {
  s3tc: boolean;
  s3tcSrgb: boolean;
}

export interface ParsedVdxtMip {
  data: Uint8Array;
  width: number;
  height: number;
}

export interface ParsedVdxt {
  width: number;
  height: number;
  format: VdxtFormat;
  mipmaps: ParsedVdxtMip[];
  byteLength: number;
}

export interface VbspDxtStats {
  compressed: number;
  fallback: number;
  totalBytes: number;
  mipCountTotal: number;
}

/** 检测 WebGLRenderer 是否同时支持 S3TC 与 S3TC_SRGB（Three.js 0.165 sRGB 压缩纹理必须两者兼具）。 */
export function detectDxtCapabilities(webglRenderer?: THREE.WebGLRenderer | null): DxtCapabilities {
  if ((globalThis as { __vbspDxtCpuFallback?: boolean }).__vbspDxtCpuFallback === true) {
    return { s3tc: false, s3tcSrgb: false };
  }
  const exts = webglRenderer?.extensions;
  if (!exts) return { s3tc: false, s3tcSrgb: false };
  return {
    s3tc: Boolean(exts.get('WEBGL_compressed_texture_s3tc')),
    s3tcSrgb: Boolean(exts.get('WEBGL_compressed_texture_s3tc_srgb')),
  };
}

function blockBytesForFormat(format: VdxtFormat): number {
  return format === 1 || format === 2 ? 8 : 16;
}

function mipByteSize(format: VdxtFormat, w: number, h: number): number {
  const bx = (Math.max(1, w) + 3) >> 2;
  const by = (Math.max(1, h) + 3) >> 2;
  return bx * by * blockBytesForFormat(format);
}

/**
 * 解析 `VDXT` 二进制缓冲。
 *
 * 为避免整份几十 MB 的 GLB ArrayBuffer 在 `parseAsync` 后被纹理切片持续钉在内存中，
 * 这里会拷贝该张贴图的独立字节区间，再在其上切出各层 mip 视图。
 */
export function parseVdxtBuffer(
  buffer: ArrayBuffer,
  byteOffset = 0,
  byteLength = buffer.byteLength - byteOffset,
): ParsedVdxt | null {
  if (byteOffset < 0 || byteLength < VDXT_HEADER_BYTES || byteOffset + byteLength > buffer.byteLength) {
    return null;
  }
  const view = new DataView(buffer, byteOffset, byteLength);
  if (
    view.getUint8(0) !== 0x56 || // 'V'
    view.getUint8(1) !== 0x44 || // 'D'
    view.getUint8(2) !== 0x58 || // 'X'
    view.getUint8(3) !== 0x54    // 'T'
  ) {
    return null;
  }
  const width = view.getUint16(4, true);
  const height = view.getUint16(6, true);
  const rawFormat = view.getUint8(8);
  const mipCount = view.getUint8(9);
  if (width < 4 || height < 4 || mipCount < 1) return null;
  if (rawFormat !== 1 && rawFormat !== 2 && rawFormat !== 3 && rawFormat !== 5) return null;
  const format = rawFormat as VdxtFormat;

  const owned = new Uint8Array(byteLength);
  owned.set(new Uint8Array(buffer, byteOffset, byteLength));

  const mipmaps: ParsedVdxtMip[] = [];
  let cursor = VDXT_HEADER_BYTES;
  for (let m = 0; m < mipCount; m++) {
    const mw = Math.max(1, width >> m);
    const mh = Math.max(1, height >> m);
    const sz = mipByteSize(format, mw, mh);
    if (cursor + sz > byteLength) return null;
    mipmaps.push({
      data: owned.subarray(cursor, cursor + sz),
      width: mw,
      height: mh,
    });
    cursor += sz;
  }

  return { width, height, format, mipmaps, byteLength };
}

function rgb565To888(c: number, out: Uint8Array, off: number): void {
  const r5 = (c >> 11) & 0x1f;
  const g6 = (c >> 5) & 0x3f;
  const b5 = c & 0x1f;
  out[off] = (r5 << 3) | (r5 >> 2);
  out[off + 1] = (g6 << 2) | (g6 >> 4);
  out[off + 2] = (b5 << 3) | (b5 >> 2);
}

/** CPU 回退解码：将 DXT1/DXT1A/DXT3/DXT5 的 mip 0 解压为 RGBA8。 */
export function decodeDxtMip0ToRgba(parsed: ParsedVdxt): Uint8Array {
  const { width, height, format } = parsed;
  const src = parsed.mipmaps[0].data;
  const rgba = new Uint8Array(width * height * 4);
  const bx = (width + 3) >> 2;
  const by = (height + 3) >> 2;
  const blockSize = blockBytesForFormat(format);
  const colors = new Uint8Array(16);
  const alphaPal = new Uint8Array(8);

  for (let gy = 0; gy < by; gy++) {
    for (let gx = 0; gx < bx; gx++) {
      const bOff = (gy * bx + gx) * blockSize;
      const cOff = format === 1 || format === 2 ? bOff : bOff + 8;

      const c0 = src[cOff] | (src[cOff + 1] << 8);
      const c1 = src[cOff + 2] | (src[cOff + 3] << 8);
      rgb565To888(c0, colors, 0);
      colors[3] = 255;
      rgb565To888(c1, colors, 4);
      colors[7] = 255;

      if (format === 1 || format === 2 ? c0 > c1 : true) {
        for (let k = 0; k < 3; k++) {
          colors[8 + k] = ((2 * colors[k] + colors[4 + k] + 1) / 3) | 0;
          colors[12 + k] = ((colors[k] + 2 * colors[4 + k] + 1) / 3) | 0;
        }
        colors[11] = 255;
        colors[15] = 255;
      } else {
        for (let k = 0; k < 3; k++) {
          colors[8 + k] = (colors[k] + colors[4 + k]) >> 1;
          colors[12 + k] = 0;
        }
        colors[11] = 255;
        colors[15] = format === 2 ? 0 : 255;
      }

      if (format === 5) {
        const a0 = src[bOff];
        const a1 = src[bOff + 1];
        alphaPal[0] = a0;
        alphaPal[1] = a1;
        if (a0 > a1) {
          for (let k = 1; k <= 6; k++) {
            alphaPal[k + 1] = (((7 - k) * a0 + k * a1 + 3) / 7) | 0;
          }
        } else {
          for (let k = 1; k <= 4; k++) {
            alphaPal[k + 1] = (((5 - k) * a0 + k * a1 + 2) / 5) | 0;
          }
          alphaPal[6] = 0;
          alphaPal[7] = 255;
        }
      }

      const bits =
        (src[cOff + 4] |
          (src[cOff + 5] << 8) |
          (src[cOff + 6] << 16) |
          (src[cOff + 7] << 24)) >>>
        0;

      for (let py = 0; py < 4; py++) {
        const iy = gy * 4 + py;
        if (iy >= height) continue;
        for (let px = 0; px < 4; px++) {
          const ix = gx * 4 + px;
          if (ix >= width) continue;
          const pIdx = py * 4 + px;
          const code = (bits >>> (pIdx * 2)) & 3;
          const dst = (iy * width + ix) * 4;
          rgba[dst] = colors[code * 4];
          rgba[dst + 1] = colors[code * 4 + 1];
          rgba[dst + 2] = colors[code * 4 + 2];
          if (format === 1 || format === 2) {
            rgba[dst + 3] = colors[code * 4 + 3];
          } else if (format === 3) {
            const aByte = src[bOff + py * 2 + (px >> 1)];
            const a4 = (px & 1) === 0 ? aByte & 0xf : (aByte >> 4) & 0xf;
            rgba[dst + 3] = a4 * 17;
          } else {
            const bitPos = pIdx * 3;
            const byteIdx = bitPos >> 3;
            const bitOff = bitPos & 7;
            const lo = src[bOff + 2 + byteIdx];
            const hi = byteIdx + 1 < 6 ? src[bOff + 2 + byteIdx + 1] : 0;
            const aCode = ((lo | (hi << 8)) >>> bitOff) & 7;
            rgba[dst + 3] = alphaPal[aCode];
          }
        }
      }
    }
  }

  return rgba;
}

/** 根据 WebGL 能力创建 `THREE.CompressedTexture`（优先）或回退 `THREE.DataTexture`。 */
export function createDxtTexture(
  parsed: ParsedVdxt,
  caps: DxtCapabilities,
): { texture: THREE.Texture; isCompressed: boolean } {
  if (caps.s3tc && caps.s3tcSrgb) {
    const threeFmt: THREE.CompressedPixelFormat =
      parsed.format === 1
        ? THREE.RGB_S3TC_DXT1_Format
        : parsed.format === 2
          ? THREE.RGBA_S3TC_DXT1_Format
          : parsed.format === 3
            ? THREE.RGBA_S3TC_DXT3_Format
            : THREE.RGBA_S3TC_DXT5_Format;

    const tex = new THREE.CompressedTexture(
      parsed.mipmaps as unknown as ImageData[],
      parsed.width,
      parsed.height,
      threeFmt,
    );
    tex.minFilter = parsed.mipmaps.length > 1 ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.generateMipmaps = false;
    tex.flipY = false;
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.needsUpdate = true;
    return { texture: tex, isCompressed: true };
  }

  const rgba = decodeDxtMip0ToRgba(parsed);
  const tex = new THREE.DataTexture(rgba, parsed.width, parsed.height, THREE.RGBAFormat);
  tex.flipY = false;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return { texture: tex, isCompressed: false };
}

const VDXT_WEBGL_WRAPPINGS: Record<number, THREE.Wrapping> = {
  33071: THREE.ClampToEdgeWrapping,
  33648: THREE.MirroredRepeatWrapping,
  10497: THREE.RepeatWrapping,
};

const VDXT_WEBGL_FILTERS: Record<number, THREE.TextureFilter> = {
  9728: THREE.NearestFilter,
  9729: THREE.LinearFilter,
  9984: THREE.NearestMipmapNearestFilter,
  9985: THREE.LinearMipmapNearestFilter,
  9986: THREE.NearestMipmapLinearFilter,
  9987: THREE.LinearMipmapLinearFilter,
};

/**
 * 向 `GLTFLoader` 注册 `VBSP_texture_dxt` 插件：
 * 遇到 `mimeType === "application/x-vbsp-dxt"` 的 image 时直接从 bufferView 构造纹理，
 * 其它 `image/png` 等仍返回 `null` 交给原生管线。
 */
export function registerVbspDxtPlugin(loader: GLTFLoader, caps: DxtCapabilities): void {
  const stats: VbspDxtStats = {
    compressed: 0,
    fallback: 0,
    totalBytes: 0,
    mipCountTotal: 0,
  };
  (globalThis as { __vbspDxtStats?: VbspDxtStats }).__vbspDxtStats = stats;

  loader.register((parser: GLTFParser) => {
    const cache = new Map<string, Promise<THREE.Texture>>();
    return {
      name: 'VBSP_texture_dxt',
      loadTexture(textureIndex: number): Promise<THREE.Texture> | null {
        const json = parser.json as {
          textures?: Array<{ source?: number; sampler?: number; name?: string }>;
          images?: Array<{ mimeType?: string; bufferView?: number; name?: string }>;
          samplers?: Array<{
            magFilter?: number;
            minFilter?: number;
            wrapS?: number;
            wrapT?: number;
          }>;
        };
        const textureDef = json.textures?.[textureIndex];
        if (!textureDef || textureDef.source === undefined) return null;
        const sourceDef = json.images?.[textureDef.source];
        const bvIndex = sourceDef?.bufferView;
        if (!sourceDef || sourceDef.mimeType !== VDXT_MIME || bvIndex === undefined) {
          return null;
        }

        const cacheKey = `${bvIndex}:${textureDef.sampler ?? ''}`;
        const cached = cache.get(cacheKey);
        if (cached) return cached;

        const promise = (async (): Promise<THREE.Texture> => {
          const ab = (await parser.getDependency('bufferView', bvIndex)) as ArrayBuffer;
          const parsed = parseVdxtBuffer(ab);
          if (!parsed) {
            throw new Error(`Invalid VDXT bufferView ${bvIndex} for texture ${textureIndex}`);
          }

          const { texture, isCompressed } = createDxtTexture(parsed, caps);
          texture.name = textureDef.name || sourceDef.name || '';

          const sampler =
            textureDef.sampler !== undefined ? json.samplers?.[textureDef.sampler] : undefined;
          if (sampler) {
            if (sampler.magFilter && VDXT_WEBGL_FILTERS[sampler.magFilter]) {
              texture.magFilter = VDXT_WEBGL_FILTERS[sampler.magFilter] as THREE.MagnificationTextureFilter;
            }
            if (sampler.minFilter && VDXT_WEBGL_FILTERS[sampler.minFilter]) {
              const f = VDXT_WEBGL_FILTERS[sampler.minFilter] as THREE.MinificationTextureFilter;
              texture.minFilter =
                isCompressed && parsed.mipmaps.length === 1
                  ? f === THREE.NearestFilter
                    ? THREE.NearestFilter
                    : THREE.LinearFilter
                  : f;
            }
            if (sampler.wrapS && VDXT_WEBGL_WRAPPINGS[sampler.wrapS]) {
              texture.wrapS = VDXT_WEBGL_WRAPPINGS[sampler.wrapS];
            }
            if (sampler.wrapT && VDXT_WEBGL_WRAPPINGS[sampler.wrapT]) {
              texture.wrapT = VDXT_WEBGL_WRAPPINGS[sampler.wrapT];
            }
          }

          parser.associations.set(texture, { textures: textureIndex });
          if (isCompressed) stats.compressed++;
          else stats.fallback++;
          stats.totalBytes += parsed.byteLength;
          stats.mipCountTotal += parsed.mipmaps.length;
          return texture;
        })();

        cache.set(cacheKey, promise);
        return promise;
      },
    };
  });
}
