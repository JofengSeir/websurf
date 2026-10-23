"""把 VTF（DXT1/DXT5/BGRA8888）里指定尺寸的 mip 解成 PNG。

用途：`test/fallback-src/materials/dev/water_dudv.vtf` 是起源水面的**波纹扭曲图**
（R=du, G=dv, A=扭曲强度），但它既不在 BSP pakfile 里、也没进 textures.mtz ⇒ 这里解出一张
小尺寸 PNG 当共享 web 资产，渲染端就不用再自己造正弦波纹了。

只用标准库：zlib 打 PNG，struct 解 VTF/DXT。
"""
import struct
import sys
import zlib

PATH = sys.argv[1]
TARGET = int(sys.argv[2]) if len(sys.argv) > 2 else 256
OUT = sys.argv[3] if len(sys.argv) > 3 else "water_dudv.png"


def mip_bytes(f, w, h):
    if f in (13, 20):  # DXT1
        return max(1, (w + 3) // 4) * max(1, (h + 3) // 4) * 8
    if f in (14, 15):  # DXT3 / DXT5
        return max(1, (w + 3) // 4) * max(1, (h + 3) // 4) * 16
    if f in (0, 1, 11, 12, 16):  # 8888 家族（每像素 4 字节）
        return w * h * 4
    if f in (2, 3, 9, 10):  # RGB/BGR 888
        return w * h * 3
    if f in (4, 17, 18):  # 565/5551
        return w * h * 2
    if f in (6, 19):  # IA88 / BGRA4444
        return w * h * 2
    if f in (5, 8, 21):  # I8 / A8 / BGRA5551
        return w * h * 1
    if f == 22:  # UV88（起源的 DU/DV 就是它：每像素 U,V 各 1 字节）
        return w * h * 2
    if f == 23:  # UVWQ8888
        return w * h * 4
    raise ValueError("未支持的 VTF 格式 %d" % f)


def decode_raw(data, w, h, fmt):
    """非压缩格式 → RGBA。只实现本仓用到的：UV88（DU/DV）、BGRA8888、BGR888、I8/A8。"""
    out = bytearray(w * h * 4)
    for i in range(w * h):
        if fmt == 22:  # UV88：U→R, V→G（起源 DU/DV 的 R=du G=dv）
            u, v = data[i * 2], data[i * 2 + 1]
            out[i * 4:i * 4 + 4] = bytes((u, v, 128, 255))
        elif fmt == 12:  # BGRA8888
            b, g, r, a = data[i * 4], data[i * 4 + 1], data[i * 4 + 2], data[i * 4 + 3]
            out[i * 4:i * 4 + 4] = bytes((r, g, b, a))
        elif fmt in (2, 3):  # RGB888 / BGR888
            if fmt == 3:
                b, g, r = data[i * 3], data[i * 3 + 1], data[i * 3 + 2]
            else:
                r, g, b = data[i * 3], data[i * 3 + 1], data[i * 3 + 2]
            out[i * 4:i * 4 + 4] = bytes((r, g, b, 255))
        elif fmt in (5, 8):  # I8 / A8 → 灰度
            v = data[i]
            out[i * 4:i * 4 + 4] = bytes((v, v, v, 255))
        else:
            raise ValueError("未实现的原始格式 %d" % fmt)
    return bytes(out)


def rgb565(v):
    r = (v >> 11) & 0x1F
    g = (v >> 5) & 0x3F
    b = v & 0x1F
    return (r << 3 | r >> 2, g << 2 | g >> 4, b << 3 | b >> 2)


def decode_dxt(data, w, h, dxt5):
    out = bytearray(w * h * 4)
    bw, bh = max(1, (w + 3) // 4), max(1, (h + 3) // 4)
    stride = 16 if dxt5 else 8
    for by in range(bh):
        for bx in range(bw):
            blk = data[(by * bw + bx) * stride:(by * bw + bx + 1) * stride]
            if dxt5:
                a0, a1 = blk[0], blk[1]
                bits = int.from_bytes(blk[2:8], "little")
                alphas = [a0, a1]
                if a0 > a1:
                    alphas += [((7 - i) * a0 + i * a1) // 7 for i in range(1, 7)]
                else:
                    alphas += [((5 - i) * a0 + i * a1) // 5 for i in range(1, 5)] + [0, 255]
                c = blk[8:]
            else:
                alphas = None
                c = blk
            c0, c1 = struct.unpack_from("<HH", c, 0)
            idx = int.from_bytes(c[4:8], "little") if dxt5 else int.from_bytes(c[4:8], "little")
            r0, g0, b0 = rgb565(c0)
            r1, g1, b1 = rgb565(c1)
            pal = [(r0, g0, b0), (r1, g1, b1)]
            if c0 > c1:
                pal += [((2 * r0 + r1) // 3, (2 * g0 + g1) // 3, (2 * b0 + b1) // 3),
                        ((r0 + 2 * r1) // 3, (g0 + 2 * g1) // 3, (b0 + 2 * b1) // 3)]
            else:
                pal += [((r0 + r1) // 2, (g0 + g1) // 2, (b0 + b1) // 2), (0, 0, 0)]
            for py in range(4):
                for px in range(4):
                    x, y = bx * 4 + px, by * 4 + py
                    if x >= w or y >= h:
                        continue
                    bit = 2 * (4 * py + px)
                    r, g, b = pal[(idx >> bit) & 3]
                    o = (y * w + x) * 4
                    out[o] = r
                    out[o + 1] = g
                    out[o + 2] = b
                    out[o + 3] = alphas[(bits >> (3 * (4 * py + px))) & 7] if alphas else 255
    return bytes(out)


def write_png(path, w, h, rgba):
    raw = b"".join(b"\x00" + rgba[y * w * 4:(y + 1) * w * 4] for y in range(h))

    def chunk(tag, payload):
        return (struct.pack(">I", len(payload)) + tag + payload
                + struct.pack(">I", zlib.crc32(tag + payload) & 0xFFFFFFFF))

    png = (b"\x89PNG\r\n\x1a\n"
           + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0))
           + chunk(b"IDAT", zlib.compress(raw, 9))
           + chunk(b"IEND", b""))
    with open(path, "wb") as f:
        f.write(png)


data = open(PATH, "rb").read()
w, h = struct.unpack_from("<HH", data, 16)
fmt, = struct.unpack_from("<I", data, 52)
mips, = struct.unpack_from("<B", data, 56)
lowfmt, = struct.unpack_from("<I", data, 57)
loww, lowh = struct.unpack_from("<BB", data, 61)
hsize, = struct.unpack_from("<I", data, 12)
hw_ver = struct.unpack_from("<I", data, 8)[0]
frames, = struct.unpack_from("<H", data, 24)
print(f"{PATH}: {w}x{h} fmt={fmt} mips={mips} frames={frames} ver={hw_ver:x} "
      f"lowres fmt={lowfmt} {loww}x{lowh}")

off = hsize + mip_bytes(lowfmt, loww, lowh)
bw, bh = w, h
for level in range(mips):
    n = mip_bytes(fmt, bw, bh)
    if bw <= TARGET or level == mips - 1:
        dxt = fmt in (13, 14, 15, 20)
        rgba = (decode_dxt(data[off:off + n], bw, bh, fmt in (14, 15)) if dxt
                else decode_raw(data[off:off + n], bw, bh, fmt))
        write_png(OUT, bw, bh, rgba)
        print(f"写出 {OUT}: mip{level} {bw}x{bh}（压缩={dxt}）")
        break
    off += n
    bw, bh = max(1, bw // 2), max(1, bh // 2)
