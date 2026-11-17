//! feature `core`：三端共用的无状态纹理导出（VTF→PNG / mosaic 编解码 / MTZ 解压）。
//!
//! 迁移自三个 app 的 `crates/wasm/src/lib.rs`，函数签名、JS 导出名与错误文本逐字保留：
//! - `decode_vtf_to_png`（三端；T-416 起供 TS 天空盒解码复用）
//! - `mosaic_encode` / `mosaic_decode`（三端；纹理画质档低清纹理字节码）
//! - `decompress_mtz`（三端；默认纹理包 textures.mtz → JSON 文本）

use std::io::Cursor;

use wasm_bindgen::prelude::*;

use websurf_wasm_core::texture_utils;

/// 把任意 `Debug` 错误拼成 `"{ctx}: {e:?}"` 文本的 [`JsValue`]（与迁移前逐字一致）。
fn to_js_err<E: std::fmt::Debug>(e: E, ctx: &str) -> JsValue {
    JsValue::from_str(&format!("{}: {:?}", ctx, e))
}

/// VTF 字节 → PNG 字节：取最高分辨率图的第 0 帧重新编码。
#[wasm_bindgen]
pub fn decode_vtf_to_png(data: &[u8]) -> Result<Vec<u8>, JsValue> {
    let vtf = texture_utils::from_bytes(data).map_err(|e| to_js_err(e, "VTF 解析失败"))?;
    let image = vtf
        .highres_image
        .decode(0)
        .map_err(|e| to_js_err(e, "VTF 图像解码失败"))?;

    let mut output: Vec<u8> = Vec::new();
    image
        .write_to(&mut Cursor::new(&mut output), image::ImageFormat::Png)
        .map_err(|e| to_js_err(e, "PNG 编码失败"))?;

    Ok(output)
}

/// PNG 字节 → mosaic v4 纹理字节码（压缩）；错误文本前缀 `mosaic_encode`。
#[wasm_bindgen]
pub fn mosaic_encode(png: &[u8], name: &str) -> Result<String, JsValue> {
    websurf_wasm_core::mosaic::encode::img_to_code(png, name)
        .map_err(|e| JsValue::from_str(&format!("mosaic_encode: {e}")))
}

/// mosaic v4 字节码 → PNG 字节（低清还原，最近邻放大 ×scale，默认 ×8）；错误文本前缀 `mosaic_decode`。
#[wasm_bindgen]
pub fn mosaic_decode(code: &str, scale: u32) -> Result<Vec<u8>, JsValue> {
    websurf_wasm_core::mosaic::decode::code_to_img(code, scale)
        .map_err(|e| JsValue::from_str(&format!("mosaic_decode: {e}")))
}

/// 解压默认配置纹理包（textures.mtz，MTZ6 兼容 MTZ5）→ JSON 文本；错误文本前缀 `decompress_mtz`。
#[wasm_bindgen]
pub fn decompress_mtz(bytes: &[u8]) -> Result<String, JsValue> {
    websurf_wasm_core::mosaic::mtz::decompress_mtz(bytes)
        .map_err(|e| JsValue::from_str(&format!("decompress_mtz: {e}")))
}
