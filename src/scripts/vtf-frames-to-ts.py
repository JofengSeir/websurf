"""把 VTF 的动画帧解成 TS 常量（RG8 原始条带 + base64），供渲染端做"换帧"动画。

为什么需要：Source 的水面动态**不是**平移一张图，而是 `water.cpp` 里
`BindTexture( SHADER_SAMPLER4, NORMALMAP, BUMPFRAME )` + VMT 的
`Proxies → AnimatedTexture`（`animatedtexturevar "$normalmap"`、`framenumvar "$bumpframe"`、
`framerate 30`）—— **29 帧循环播放**；再配合 `SCROLL1/SCROLL2` 触发 MULTITEXTURE，
片元里 `vNormal = 0.33 * ( vNormal + vNormal1 + vNormal2 )` 做三次采样平均。
只平移单帧（本工程之前那样）看起来就是"整张图在滑"，不是涟漪。

数据源：`test/fallback-src/materials/dev/water_dudv.vtf`（VTF 7.1，256²，格式 **UV88**：
每个像素 2 字节 U,V，128 = 无偏移，29 帧，每帧含全部 mip）。

用法：
  python src/scripts/vtf-frames-to-ts.py <vtf> <size> <step> <out.ts>
例：python src/scripts/vtf-frames-to-ts.py test/fallback-src/materials/dev/water_dudv.vtf 64 2 src/renderer-shared/shader/water-dudv-data.ts
"""
import base64
import json
import struct
import sys

PATH, SIZE, STEP, OUT = sys.argv[1], int(sys.argv[2]), int(sys.argv[3]), sys.argv[4]


def mip_bytes(f, w, h):
    if f in (13, 20):
        return max(1, (w + 3) // 4) * max(1, (h + 3) // 4) * 8
    if f in (14, 15):
        return max(1, (w + 3) // 4) * max(1, (h + 3) // 4) * 16
    if f in (0, 1, 11, 12, 16):
        return w * h * 4
    if f in (2, 3, 9, 10):
        return w * h * 3
    if f in (4, 17, 18, 6, 19):
        return w * h * 2
    if f in (5, 8, 21):
        return w * h * 1
    if f == 22:
        return w * h * 2
    if f == 23:
        return w * h * 4
    raise ValueError("未支持的 VTF 格式 %d" % f)


def frame_rg(data, base, fmt, w, h, mips, target):
    """取该帧里尺寸 <= target 的那级 mip，返回字节数 w*h*2 的 RG 数据。"""
    off = base
    cw, ch = w, h
    for _ in range(mips):
        n = mip_bytes(fmt, cw, ch)
        if cw <= target or (cw, ch) == (1, 1):
            raw = data[off:off + n]
            if fmt == 22:  # UV88：逐像素 U,V
                return cw, ch, raw
            raise ValueError("只实现了 UV88（本图就是），实际 fmt=%d" % fmt)
        off += n
        cw, ch = max(1, cw // 2), max(1, ch // 2)
    raise ValueError("没找到目标 mip")


d = open(PATH, "rb").read()
W, H = struct.unpack_from("<HH", d, 16)
fmt, = struct.unpack_from("<I", d, 52)
mips, = struct.unpack_from("<B", d, 56)
frames, = struct.unpack_from("<H", d, 24)
lowfmt, = struct.unpack_from("<I", d, 57)
loww, lowh = struct.unpack_from("<BB", d, 61)
hsize, = struct.unpack_from("<I", d, 12)

# 每帧占：全部 mip 之和
per_frame = 0
cw, ch = W, H
for _ in range(mips):
    per_frame += mip_bytes(fmt, cw, ch)
    cw, ch = max(1, cw // 2), max(1, ch // 2)
first = hsize + mip_bytes(lowfmt, loww, lowh)

idx = list(range(0, frames, STEP))
planes = []
mw = mh = 0
for i in idx:
    w, h, raw = frame_rg(d, first + i * per_frame, fmt, W, H, mips, SIZE)
    mw, mh = w, h
    planes.append(raw)
strip = b"".join(planes)
b64 = base64.b64encode(strip).decode("ascii")

ts = f"""/**
 * **自动生成，不要手改**：起源水面失真图 `dev/water_dudv` 的**动画帧条带**。
 *
 * 每帧 {mw}x{mh}、RG8（原 UV88 的 U/V 两字节，128 = 无偏移），共 {len(idx)} 帧
 * （源 VTF 共 {frames} 帧，这里每 {STEP} 帧取一帧），按帧序拼成一条 {mw}x{mh * len(idx)} 的竖条带。
 * 渲染端把它当成**竖排图集**（每帧一个 `Texture` 克隆，用 offset/repeat 取第 i 行）做换帧 —
 * 这是 `water.cpp` 的 `NORMALMAP + BUMPFRAME` + VMT `Proxies → AnimatedTexture`(30fps) 的对应实现。
 *
 * 重新生成：
 *   python src/scripts/vtf-frames-to-ts.py test/fallback-src/materials/dev/water_dudv.vtf {mw} {STEP} src/renderer-shared/shader/water-dudv-data.ts
 */
export const WATER_DUDV = {{
  /** 单帧宽高（像素） */
  width: {mw},
  height: {mh},
  /** 条带里的帧数（= 图集行数） */
  frames: {len(idx)},
  /** 源 VTF 的原始帧数（仅作记录） */
  sourceFrames: {frames},
  /** 帧间步长（仅作记录） */
  frameStep: {STEP},
  /** 原始 RG8 条带（base64；解码后长度 = width * height * frames * 2） */
  rg8Base64:
    '{b64}',
}};
"""
with open(OUT, "w", encoding="utf-8", newline="\n") as f:
    f.write(ts)
print(f"[vtf-frames] {PATH}: {frames} 帧 → 取 {len(idx)} 帧（每 {STEP} 帧一帧）{mw}x{mh} "
      f"条带 {len(strip)} B → base64 {len(b64)} 字符 → {OUT}")
