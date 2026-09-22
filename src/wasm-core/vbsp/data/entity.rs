//! 实体键值文本的解析层：把 entities lump 的纯文本切成一个个实体块，再按需取键。
//!
//! 上游：`src/wasm-core/vbsp/reader.rs` 的 `LumpReader::read_entities` 把整段 lump 字节按
//! UTF-8 解码、**整体转成小写**后包成 `Entities`；`src/wasm-core/vbsp/mod.rs` 的 `Bsp` 以
//! 字段 `entities` 持有它。因此进入本文件的键名与值全都已经是小写。
//! 下游：`src/wasm-core/vbsp/data/mod.rs` 用 `pub use self::entity::*` 把本文件并入 `data`
//! 模块，`src/wasm-core/vbsp/mod.rs` 再 `pub use crate::vbsp::data::*` 转出，所以
//! `crate::vbsp::{Entities, RawEntity, Entity, Color, LightColor}` 指的都是这里的定义。
//! 消费点集中在两处：三个工程 `crates/wasm/src/lib.rs` 的导出层（`bsp.entities.iter()` 配
//! `RawEntity::prop`），以及 `src/wasm-core/bsp_to_gltf_core/convert.rs` 的 `bsp_models`
//! （配 `RawEntity::parse`）。
//!
//! 职责：
//! - `Entities::iter`：按 `{` / `}` 切块，产出借用原文的 `RawEntity`；
//! - `RawEntity::properties` / `prop` / `prop_parse`：按引号成对扫描取值；
//! - `RawEntity::parse`：交给外部依赖 `vdf-reader`（`src/wasm-core/Cargo.toml` 的
//!   `vdf-reader`）反序列化成 `Entity`（45 个变体，以 `classname` 作内部标签）；
//! - `EntityProp` / `FromStrProp`：值类型到文本解析之间的适配层；
//! - `Color` / `LightColor`：实体颜色字段的两个类型，定义在本文件而非 `data/mod.rs`。
//!
//! 关键不变量与坑：
//! - **键名按小写逐字节比较**：`RawEntity::prop` 的判据是 `key == prop_key`，而文本已被
//!   `read_entities` 降为小写，所以键实参必须写小写；本文件全部 `#[serde(rename = ...)]`
//!   的值同样是小写。
//! - **两套布尔口径**：`EntityProp for bool` 是 `raw != "0"`（只有精确的 `"0"` 为假），
//!   而结构体字段上的 `bool_from_int` 把值当整数解析后取 `> 0`（非数字直接报错）。
//! - **切块与取值都只看引号 / 花括号**：不处理引号内的 `}`、不成对的花括号与嵌套块；
//!   遇到这类文本时迭代提前结束，残尾被丢弃而不是报错。
//! - **重复键的取值不一致**：`RawEntity::prop` 取**首个**匹配，而 `RawEntity` 的 `Debug`
//!   把键值收进 `HashMap` 再打印（后者覆盖前者，看到的是末个值）。
//! - `RawEntity::parse` 把 `vdf-reader` 的一切非 `UnknownVariant` 错误压成
//!   `EntityParseError::NoSuchProperty("unknown serde error")`——该键名与实体的真实字段
//!   无关，调用方无法从错误值反推失败原因。
//!
//! 边界：只做文本切分与键值解析。不读 lump 字节（那是 `reader.rs` 的职责），不做实体语义
//! 校验（不存在「某 classname 必须带哪些键」这类检查），也不拆分 `outputs` 之类的键族。
//!
//! 测试归属：本文件无 `#[test]`；`src/wasm-core/vbsp/mod.rs` 的 `tf2_file`（默认 `#[ignore]`）
//! 会经 `Bsp::read` 间接走到 `read_entities`。
//!
//! 同名干扰：`src/wasm-core/model_integrator/mod.rs` 另有自己的 `Entity` /
//! `EntityProperties`（字段全是 `String`，供 `resolve_placements` 使用），与本文件的
//! `Entity` 不是同一类型。

use crate::vbsp::error::EntityParseError;
use crate::vbsp::Vector;
use serde::de::{Error, Unexpected};
use serde::{Deserialize, Deserializer};
use std::fmt;
use std::fmt::Debug;
use std::str::FromStr;
use vdf_reader::VdfError;

/// entities lump 的整段文本：`{...}` 块的拼接，没有外层包装。
///
/// 本仓唯一构造点是 `src/wasm-core/vbsp/reader.rs` 的 `LumpReader::read_entities`；
/// 其余位置只经 `Entities::iter` 读取。字段本身不含任何切分结果，也不保证花括号成对。
#[derive(Clone)]
pub struct Entities {
    /// 原文（已由 `read_entities` 转成小写）。切块逻辑在 `iter`，本字段不做校验。
    pub entities: String,
}

/// 打印成 `Entities { entities: [...] }`，每个元素是 `RawEntity` 自己的 `Debug`（键值表）。
///
/// 函数体内另声明了一个同名 `Entities`，它在作用域内遮蔽外层类型：这里构造的是**内层**那个
/// 只含 `Vec<RawEntity>` 的结构体，外层 `entities: String` 不参与输出。
/// 内层字段只被 `#[derive(Debug)]` 读取，故挂 `#[allow(dead_code)]`。
impl fmt::Debug for Entities {
    fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {
        #[derive(Debug)]
        struct Entities<'a> {
            #[allow(dead_code)]
            entities: Vec<RawEntity<'a>>,
        }

        Entities {
            entities: self.iter().collect(),
        }
        .fmt(f)
    }
}

impl Entities {
    /// 按出现顺序切出 `{ ... }` 块，**含两端花括号**，产出借用原文的 `RawEntity`。
    ///
    /// 切法：从当前游标起找最近的 `{`，再从该 `{` 之后找最近的 `}`，切出这段闭区间，游标推到
    /// `}` 之后。只找这两个字符，不判断它们是否落在引号内，也不识别嵌套块。
    ///
    /// 结束条件（都由 `?` 决定，本方法没有错误路径）：当前文本里找不到 `{`，或 `{` 之后找不到
    /// `}`，迭代即结束——**花括号不成对的残尾被整段丢弃**，不报错。两个花括号之外的文本不进
    /// 结果，但其中的 `}` 会被当成最近的那个 `}`，使当前块提前结束。
    ///
    /// 不校验块的语法：切出来的内容是否可解析，只有后续取值才知道。
    pub fn iter(&self) -> impl Iterator<Item = RawEntity<'_>> {
        struct Iter<'a> {
            buf: &'a str,
        }

        impl<'a> Iterator for Iter<'a> {
            type Item = RawEntity<'a>;

            fn next(&mut self) -> Option<Self::Item> {
                let start = self.buf.find('{')?;
                let end = start + self.buf[start..].find('}')?;

                let out = &self.buf[start..end + 1];

                self.buf = &self.buf[end + 1..];

                Some(RawEntity { buf: out })
            }
        }

        Iter {
            buf: &self.entities,
        }
    }
}

/// 一个实体块的原文切片（含两端花括号），生命周期借自 `Entities::entities`。
///
/// 不做预解析：键值在调用 `properties` / `prop` 时才现场扫描，所以在同一实体上多次 `prop`
/// 会重复扫同一段文本。字段私有，对外只有 `as_str`、`properties`、`prop`、`prop_parse`、
/// `parse` 五个入口。
#[derive(Clone)]
pub struct RawEntity<'a> {
    buf: &'a str,
}

/// 打印成键值表：先 `properties()` 收进 `HashMap<&str, &str>`，再交给 `HashMap` 的 `Debug`。
///
/// 与 `prop` 的两点差异：① 重复键被后者覆盖，打印的是**末个**值（`prop` 取首个）；
/// ② 输出顺序是 `HashMap` 的迭代顺序，与实体文本里的书写顺序无关。
/// 扫描提前中断时只打印已扫出的键，不报错。
impl fmt::Debug for RawEntity<'_> {
    fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {
        use std::collections::HashMap;

        self.properties().collect::<HashMap<_, _>>().fmt(f)
    }
}

impl<'a> RawEntity<'a> {
    /// 原样返回该实体块的切片（含两端花括号），不裁剪、不规整。
    ///
    /// 本仓无调用点：生产路径用 `prop` / `properties` / `parse`。
    pub fn as_str(&self) -> &'a str {
        self.buf
    }

    /// 顺序产出块内的 `(键, 值)` 对，两侧都是原文切片（不去空白、不做转义、不做类型转换）。
    ///
    /// 扫描规则：从当前游标找第一个 `"`，到下一个 `"` 之间是键；再从键的收尾引号之后找一对
    /// 引号，其间是值；游标推到值的收尾引号之后。不区分层级，花括号与一切非引号字符都被跳过，
    /// 因此空键、空值都算合法的一对，块内嵌套出现的键值同样会被扫出来。
    ///
    /// 结束条件：任一侧找不到成对的 `"` 时迭代结束（例如键已找到但值缺收尾引号），
    /// 已产出的部分照常保留。
    pub fn properties(&self) -> impl Iterator<Item = (&'a str, &'a str)> {
        struct Iter<'a> {
            buf: &'a str,
        }

        impl<'a> Iterator for Iter<'a> {
            type Item = (&'a str, &'a str);

            fn next(&mut self) -> Option<Self::Item> {
                let start = self.buf.find('"')? + 1;
                let end = start + self.buf[start..].find('"')?;

                let key = &self.buf[start..end];

                let rest = &self.buf[end + 1..];

                let start = rest.find('"')? + 1;
                let end = start + rest[start..].find('"')?;

                let value = &rest[start..end];

                self.buf = &rest[end + 1..];

                Some((key, value))
            }
        }

        Iter { buf: self.buf }
    }

    /// 取指定键的值：线性扫描 `properties`，返回**首个**匹配的切片。
    ///
    /// `key` 必须与文本大小写完全一致——实体文本已被
    /// `src/wasm-core/vbsp/reader.rs` 的 `read_entities` 整体转成小写，各调用点传的也是小写
    /// 字面量（`"classname"` / `"origin"` / `"model"` / `"angles"` / `"targetname"` /
    /// `"spawnflags"`）；传大写时比较必然失败。
    ///
    /// 键不存在返回 `EntityParseError::NoSuchProperty(key)`，`key` 就是这里的实参；
    /// 键存在但值为空串时照常返回 `Ok("")`。
    pub fn prop(&self, key: &'static str) -> Result<&'a str, EntityParseError> {
        self.properties()
            .find_map(|(prop_key, value)| (key == prop_key).then_some(value))
            .ok_or(EntityParseError::NoSuchProperty(key))
    }

    /// 取键后交给 `EntityProp::parse` 解析成 `T`，是 `prop` 的类型化包装。
    ///
    /// 先经 `prop`（故同样要求小写键、缺键同样报 `NoSuchProperty`），再按 `T` 自己的实现解析；
    /// `T` 没有 `EntityProp` 实现时在编译期就不可用。
    ///
    /// 本仓无调用点：生产路径一律先用 `prop` 取字符串，再自行 `parse`。
    pub fn prop_parse<T: EntityProp<'a>>(&self, key: &'static str) -> Result<T, EntityParseError> {
        T::parse(self.prop(key)?)
    }

    /// 反序列化成强类型 `Entity`（按 `classname` 分派，见 `mod typed`）。
    ///
    /// 失败分两路（`vdf-reader` 的错误只在这里分一次类）：
    /// - `VdfError::UnknownVariant`：文本本身能用、只是 `classname` 不在 `Entity` 的标签表里
    ///   ⇒ `Ok(Entity::Unknown(self.clone()))`，原文仍可继续用 `prop` 取值；
    /// - 其余一切错误（语法不合法、字段缺失、类型不符）⇒
    ///   `Err(EntityParseError::NoSuchProperty("unknown serde error"))`。
    ///
    /// 后者的键名是固定字面量，不指向实体的任何真实字段；`src/wasm-core/bsp_to_gltf_core/convert.rs`
    /// 的 `bsp_models` 用 `flat_map` 把全部 `Err` 直接丢弃。
    pub fn parse(&self) -> Result<Entity<'a>, EntityParseError> {
        match vdf_reader::from_str(self.buf) {
            Ok(entity) => Ok(entity),
            Err(VdfError::UnknownVariant(_)) => Ok(Entity::Unknown(self.clone())),
            Err(_) => Err(EntityParseError::NoSuchProperty("unknown serde error")),
        }
    }
}

/// 值类型与实体文本之间的解析接口：把一段 `&'a str` 解成 `Self`。
///
/// 共 5 个实现，全在本文件：1 个泛型实现覆盖 `FromStrProp` 的 6 个类型
/// （`u8` / `u16` / `f32` / `u32` / `i32` / `Vector`），另有 4 个专用实现——
/// `[T; N]`、`&'a str`、`bool`、`Option<T>`。
///
/// 边界：`Angles` 与 `LightColor` 各自实现了 `FromStr`，但**不在** `FromStrProp` 名单里，
/// 因此不能用作 `prop_parse` 的目标类型；它们只经 serde 的 `Deserialize` 参与实体解析。
pub trait EntityProp<'a>: Sized {
    /// 解析一段原始文本；失败原因由具体实现决定，统一归到 `EntityParseError`。
    fn parse(raw: &'a str) -> Result<Self, EntityParseError>;
}

/// 私有标记 trait：只有实现它的类型才能走下面那条泛型 `EntityProp` 实现。
///
/// 名单就是紧随其后的 6 个「能用 `FromStr` 解析」的值类型；新增值类型时在此补一行 `impl`，
/// 未列入的类型不会获得 `EntityProp`。
trait FromStrProp: FromStr {}

// 六个值类型：无符号 u8 / u16 / u32、有符号 i32、浮点 f32，以及 BSP 坐标向量 Vector。
// 它们的 FromStr::Err 是 ParseIntError / ParseFloatError（Vector 直接就是 EntityParseError），
// 前者由 src/wasm-core/vbsp/error.rs 的 EntityParseError 两个 #[from] 承接。
impl FromStrProp for u8 {}
impl FromStrProp for u16 {}
impl FromStrProp for f32 {}
impl FromStrProp for u32 {}
impl FromStrProp for i32 {}
impl FromStrProp for Vector {}

/// 泛型实现：任何 `FromStrProp` 类型都能直接当实体值，错误经 `?` 转成 `EntityParseError`。
impl<T: FromStrProp> EntityProp<'_> for T
where
    EntityParseError: From<<T as FromStr>::Err>,
{
    fn parse(raw: &'_ str) -> Result<Self, EntityParseError> {
        Ok(raw.parse()?)
    }
}

/// 定长数组：把值按**单个空格**切分，逐个解析出 `N` 个元素，多余的元素被忽略。
///
/// 只有「元素个数不足 `N`」才报 `EntityParseError::ElementCount`；某个元素自身解析失败时，
/// 该元素自己的错误（`Int` / `Float`）直接上抛。
/// 切分用的是 `split(' ')` 而不是 `split_whitespace()`：连续两个空格会切出空串元素并因此报错，
/// 制表符也不算分隔符——实体文本写成 `"255  255 255"` 的字段取不到值。
impl<T: FromStrProp, const N: usize> EntityProp<'_> for [T; N]
where
    EntityParseError: From<<T as FromStr>::Err>,
    [T; N]: Default,
{
    fn parse(raw: &'_ str) -> Result<Self, EntityParseError> {
        let mut values = raw.split(' ').map(T::from_str);
        let mut result = <[T; N]>::default();
        for item in result.iter_mut() {
            *item = values.next().ok_or(EntityParseError::ElementCount)??;
        }
        Ok(result)
    }
}

/// 字符串值：原样返回。两侧引号已在 `RawEntity::properties` 里剥掉，这里不做去空白。
impl<'a> EntityProp<'a> for &'a str {
    fn parse(raw: &'a str) -> Result<Self, EntityParseError> {
        Ok(raw)
    }
}

/// 布尔值：**只有**精确的 `"0"` 是假，其余任何字符串（含 `"false"`、空串）都是真。
///
/// 与结构体字段用的 `bool_from_int` 是两套口径（后者把值当整数解析再取 `> 0`）：
/// 走本实现的是 `prop_parse::<bool>`，走 `bool_from_int` 的是 serde 字段。
impl EntityProp<'_> for bool {
    fn parse(raw: &'_ str) -> Result<Self, EntityParseError> {
        Ok(raw != "0")
    }
}

/// `Option` 包装：成功时恒为 `Some`，**不**把解析失败折成 `None`。
///
/// 键缺失在更早一步就由 `RawEntity::prop` 报 `NoSuchProperty`，所以这里只负责解一层；
/// 需要「键可缺省」的语义只能在 serde 侧用 `#[serde(default)]` 或 `Option<T>` 字段。
impl<'a, T: EntityProp<'a>> EntityProp<'a> for Option<T> {
    fn parse(raw: &'a str) -> Result<Self, EntityParseError> {
        Ok(Some(T::parse(raw)?))
    }
}

/// 实体的 `rendercolor` 一类颜色值：`r` / `g` / `b` 三个 `u8` 分量，**没有** alpha。
///
/// 定义在本文件而不是 `src/wasm-core/vbsp/data/mod.rs`：`data/mod.rs` 只用
/// `pub use self::entity::*` 把它转出，`src/wasm-core/vbsp/mod.rs` 再转一次，所以对外的
/// 路径是 `crate::vbsp::Color`。
///
/// 只经下面的 `Deserialize` 解析（本文件没有为它实现 `EntityProp`，故不能作 `prop_parse`
/// 的目标类型）。
#[derive(Debug, Clone)]
pub struct Color {
    pub r: u8,
    pub g: u8,
    pub b: u8,
}

/// 从字符串取值：委托 `<[u8; 3]>::parse`（即上面的数组 `EntityProp` 实现）解析 `"r g b"`。
///
/// 一切失败原因（元素不足、分量不是整数）都被 `map_err` 丢成 serde 的 `invalid_value`，
/// 文案是 `"a list of 3 numbers"`，不区分是哪个分量出错。
impl<'de> Deserialize<'de> for Color {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let str = <&str>::deserialize(deserializer)?;
        let colors = <[u8; 3]>::parse(str)
            .map_err(|_| D::Error::invalid_value(Unexpected::Other(str), &"a list of 3 numbers"))?;
        Ok(Color {
            r: colors[0],
            g: colors[1],
            b: colors[2],
        })
    }
}

/// `_light` 键的值：三个 `u8` 分量加一个 `u16` 强度 `intensity`，按空格分隔。
///
/// 与 `Color` 的三点差别：① 多一个 `intensity`；② 解析走下面手写的 `FromStr`，因此能区分
/// 「元素不足」（`ElementCount`）与「元素不是整数」（`Int`）；③ serde 侧的错误文案是
/// `"a list of 4 integers"`。
///
/// 本仓只在 `Light` 与 `LightSpot` 两个结构体的 `light` 字段被引用。
#[derive(Debug, Clone)]
pub struct LightColor {
    pub r: u8,
    pub g: u8,
    pub b: u8,
    pub intensity: u16,
}

/// 按**单个空格**切分，依次取 `r` / `g` / `b` / `intensity`，多余元素被忽略。
///
/// 与 `[T; N]` 的 `EntityProp` 实现同一写法（`split(' ')` 配逐个 `next()`）：少一个元素报
/// `EntityParseError::ElementCount`，元素不是十进制整数报 `EntityParseError::Int`
/// （同一个 `map_err` 覆盖 `u8` 与 `u16` 两种宽度）。连续空格会切出空串元素并因此报 `Int`。
impl FromStr for LightColor {
    type Err = EntityParseError;

    fn from_str(str: &str) -> Result<Self, Self::Err> {
        let mut values = str.split(' ');
        Ok(LightColor {
            r: values
                .next()
                .ok_or(EntityParseError::ElementCount)?
                .parse()
                .map_err(EntityParseError::Int)?,
            g: values
                .next()
                .ok_or(EntityParseError::ElementCount)?
                .parse()
                .map_err(EntityParseError::Int)?,
            b: values
                .next()
                .ok_or(EntityParseError::ElementCount)?
                .parse()
                .map_err(EntityParseError::Int)?,
            intensity: values
                .next()
                .ok_or(EntityParseError::ElementCount)?
                .parse()
                .map_err(EntityParseError::Int)?,
        })
    }
}

/// 从字符串取值：委托上面的 `FromStr`，失败一律丢成 serde 的 `invalid_value`
/// （`Unexpected::Str`，与 `Color` 用的 `Unexpected::Other` 不同）。
impl<'de> Deserialize<'de> for LightColor {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let str = <&str>::deserialize(deserializer)?;
        str.parse()
            .map_err(|_| D::Error::invalid_value(Unexpected::Str(str), &"a list of 4 integers"))
    }
}

// 强类型实体：`Entity` 与 36 个按 classname 归类的结构体都定义在下面的私有子模块 `typed` 里，
// 这里整体转出；`data/mod.rs` 再转一层，因此 `crate::vbsp::Entity` 可用。
pub use typed::*;

/// 强类型实体视图：一个 classname 一个结构体，`Entity` 是这张分派表。
///
/// 四条贯穿全模块的规则：
/// - **键名**：`#[serde(rename = "...")]` 给出实体文本里的键名，全部小写；没写 rename 的
///   字段以字段名作键。`read_entities` 已把整段文本降为小写，三个工程导出层用
///   `RawEntity::prop` 读的是同一批小写键。
/// - **缺键**：`Option<T>` 字段与标 `#[serde(default)]` 的字段都允许缺键（分别落成 `None`
///   与 `Default::default()`）；其余字段缺键即整条实体反序列化失败。
/// - **未知键**：没有任何结构体标 `deny_unknown_fields`，实体里多出来的键一律被忽略。
///   这份表因此是**窄视图**：未声明的键要回原文用 `RawEntity::prop` 取。
/// - **`rename_all`**：`AmbientGeneric` / `LogicCase` / `Occluder` 三个结构体另标
///   `rename_all = "lowercase"`。
///
/// 现有消费面：`src/wasm-core/bsp_to_gltf_core/convert.rs` 的 `bsp_models` 只匹配 brush
/// 四类（共用 `BrushEntity`），其余变体全部落到 `_ => None`；三个工程的导出层不构造本枚举，
/// 全程用 `RawEntity::prop`。
mod typed {
    // 导入路径值得留意：`Color` / `LightColor` / `RawEntity` 由本文件顶层定义，经
    // `data/mod.rs` 的 `pub use self::entity::*` 与 `vbsp/mod.rs` 的
    // `pub use crate::vbsp::data::*` 绕回 `crate::vbsp` 命名空间；只有 `Angles` 与 `Vector`
    // 是 `data/mod.rs` 自己的类型。
    use crate::vbsp::{Angles, Color, LightColor, RawEntity, Vector};
    use serde::{Deserialize, Deserializer};

    /// 按 `classname` 分派的实体类型表：45 个变体 = 44 个具名标签 + `Unknown`。
    ///
    /// - `#[serde(tag = "classname")]`：内部标签，值取自实体文本的 `classname` 键（已小写）；
    /// - `Unknown` 挂 `#[serde(skip)]`，由 `RawEntity::parse` 在 `VdfError::UnknownVariant`
    ///   时手工构造并携带原文切片，因此**未识别的 classname 仍能用 `prop` 取值**；
    /// - 23 个变体标了 `#[serde(borrow)]`；载荷里的 `&'a str` 字段意味着解析结果直接借用
    ///   `Entities` 的文本，不产生字符串副本；
    /// - `#[non_exhaustive]`：外部 crate 匹配时必须保留 `_` 分支。
    ///
    /// 本仓消费情况：`src/wasm-core/bsp_to_gltf_core/convert.rs` 的 `bsp_models` 只挑
    /// `Brush` / `BrushIllusionary` / `BrushWall` / `BrushWallToggle` 四类，取它们的 `model`
    /// 与 `origin`，其余变体一律 `_ => None`；三个工程的导出层全程用 `RawEntity::prop`，
    /// 不构造本枚举。
    #[derive(Debug, Clone, Deserialize)]
    #[non_exhaustive]
    #[serde(tag = "classname")]
    pub enum Entity<'a> {
        #[serde(rename = "point_spotlight")]
        SpotLight(SpotLight),
        #[serde(rename = "light")]
        Light(Light),
        #[serde(rename = "light_spot")]
        LightSpot(LightSpot),
        #[serde(rename = "prop_dynamic")]
        #[serde(borrow)]
        PropDynamic(PropDynamic<'a>),
        #[serde(rename = "prop_dynamic_override")]
        #[serde(borrow)]
        PropDynamicOverride(PropDynamicOverride<'a>),
        // prop_physics_multiplayer 复用 PropDynamic 的字段集，与 prop_dynamic 同一份载荷
        #[serde(rename = "prop_physics_multiplayer")]
        #[serde(borrow)]
        PropPhysics(PropDynamic<'a>),
        #[serde(rename = "env_sprite")]
        #[serde(borrow)]
        EnvSprite(EnvSprite<'a>),
        #[serde(rename = "info_player_teamspawn")]
        #[serde(borrow)]
        Spawn(Spawn<'a>),
        #[serde(rename = "func_regenerate")]
        #[serde(borrow)]
        Regenerate(Regenerate<'a>),
        #[serde(rename = "func_respawnroom")]
        RespawnRoom(RespawnRoom<'a>),
        #[serde(rename = "func_door")]
        Door(Door<'a>),
        #[serde(rename = "worldspawn")]
        WorldSpawn(WorldSpawn<'a>),
        #[serde(rename = "info_observer_point")]
        #[serde(borrow)]
        ObserverPoint(ObserverPoint<'a>),
        // 四个 func_* 刷子实体共用一个 BrushEntity 载荷，也是本仓唯一被匹配的一族变体
        #[serde(rename = "func_brush")]
        #[serde(borrow)]
        Brush(BrushEntity<'a>),
        #[serde(rename = "func_illusionary")]
        #[serde(borrow)]
        BrushIllusionary(BrushEntity<'a>),
        #[serde(rename = "func_wall")]
        #[serde(borrow)]
        BrushWall(BrushEntity<'a>),
        #[serde(rename = "func_wall_toggle")]
        #[serde(borrow)]
        BrushWallToggle(BrushEntity<'a>),
        // 六个补给品 classname 共用两个只有 origin 的载荷类型：AmmoPack 与 HealthPack
        #[serde(rename = "item_ammopack_small")]
        AmmoPackSmall(AmmoPack),
        #[serde(rename = "item_ammopack_medium")]
        AmmoPackMedium(AmmoPack),
        #[serde(rename = "item_ammopack_full")]
        HealthPackFull(HealthPack),
        #[serde(rename = "item_healthkit_small")]
        HealthPackSmall(HealthPack),
        #[serde(rename = "item_healthkit_medium")]
        HealthPackMedium(HealthPack),
        #[serde(rename = "item_healthkit_full")]
        AmmoPackFull(AmmoPack),
        #[serde(rename = "env_lightglow")]
        LightGlow(LightGlow),
        #[serde(rename = "trigger_multiple")]
        #[serde(borrow)]
        TriggerMultiple(TriggerMultiple<'a>),
        #[serde(rename = "logic_relay")]
        LogicRelay(LogicRelay<'a>),
        #[serde(rename = "filter_activator_tfteam")]
        #[serde(borrow)]
        FilterActivatorTeam(FilterActivatorTeam<'a>),
        #[serde(rename = "logic_auto")]
        LogicAuto(LogicAuto<'a>),
        #[serde(rename = "func_dustmotes")]
        DustMotes(DustMotes<'a>),
        #[serde(rename = "sky_camera")]
        SkyCamera(SkyCamera),
        #[serde(rename = "path_track")]
        PathTrack(PathTrack<'a>),
        #[serde(rename = "env_soundscape_proxy")]
        #[serde(borrow)]
        SoundScapeProxy(SoundScapeProxy<'a>),
        #[serde(rename = "func_respawnroomvisualizer")]
        #[serde(borrow)]
        RespawnVisualizer(RespawnVisualizer<'a>),
        #[serde(rename = "info_particle_system")]
        #[serde(borrow)]
        ParticleSystem(ParticleSystem<'a>),
        #[serde(rename = "team_control_point")]
        #[serde(borrow)]
        TeamControlPoint(TeamControlPoint<'a>),
        #[serde(rename = "func_areaportal")]
        AreaPortal(AreaPortal),
        #[serde(rename = "game_text")]
        #[serde(borrow)]
        GameText(GameText<'a>),
        #[serde(rename = "keyframe_rope")]
        #[serde(borrow)]
        RopeKeyFrame(RopeKeyFrame<'a>),
        #[serde(rename = "move_rope")]
        RopeMove(RopeMove<'a>),
        #[serde(rename = "tf_gamerules")]
        #[serde(borrow)]
        GameRules(GameRules<'a>),
        #[serde(rename = "tf_logic_koth")]
        KothLogic(KothLogic),
        #[serde(rename = "ambient_generic")]
        #[serde(borrow)]
        AmbientGeneric(AmbientGeneric<'a>),
        #[serde(rename = "logic_case")]
        #[serde(borrow)]
        LogicCase(LogicCase<'a>),
        #[serde(rename = "func_occluder")]
        #[serde(borrow)]
        Occluder(Occluder<'a>),
        // 兜底分支：不参与 classname 标签匹配，只会由 RawEntity::parse 手工构造
        #[serde(skip)]
        Unknown(RawEntity<'a>),
    }

    /// map 里的 `light` 实体：世界坐标 `origin` 与 `_light` 颜色强度。
    ///
    /// 两个字段都没有 `default`，缺 `origin` 或缺 `_light` 都会让整条实体解析失败。
    #[derive(Debug, Clone, Deserialize)]
    pub struct Light {
        /// 世界坐标（BSP Z-up，未做 Y-up 变换）。
        pub origin: Vector,
        /// 键 `_light`：`"r g b intensity"` 四个空格分隔的整数。
        #[serde(rename = "_light")]
        pub light: LightColor,
    }

    /// map 里的 `point_spotlight` 实体：聚光灯的锥角来源。
    ///
    /// 锥角用的是 `spotlightwidth`（`u8`，不是 `_cone`），颜色键是 `rendercolor`。
    #[derive(Debug, Clone, Deserialize)]
    pub struct SpotLight {
        pub origin: Vector,
        /// `"pitch yaw roll"`（度）。
        pub angles: Angles,
        #[serde(rename = "rendercolor")]
        pub color: Color,
        /// 键 `spotlightwidth`：锥宽，按 `u8` 解析，超过 255 的值会解析失败。
        #[serde(rename = "spotlightwidth")]
        pub cone: u8,
    }

    /// map 里的 `light_spot` 实体：与 `SpotLight` 不同的另一套聚光灯键名。
    ///
    /// 锥角键是 `_cone`、颜色键是 `_light`——与 `SpotLight` 的 `spotlightwidth` /
    /// `rendercolor` 不通用。
    #[derive(Debug, Clone, Deserialize)]
    pub struct LightSpot {
        pub origin: Vector,
        pub angles: Angles,
        #[serde(rename = "_light")]
        pub light: LightColor,
        /// 键 `_cone`：锥宽，按 `u8` 解析。
        #[serde(rename = "_cone")]
        pub cone: u8,
    }

    /// `prop_dynamic` 与 `prop_physics_multiplayer` 两类实体的共同字段集。
    ///
    /// 被 `Entity::PropDynamic` 与 `Entity::PropPhysics` 两个变体共用（`prop_dynamic_override`
    /// 另有独立结构体）。`src/wasm-core/vbsp/data/mod.rs` 为它实现了 `as_prop_placement`
    /// （`rotation` 取 `angles`、`scale` 原样、`skin` 恒 0）；本仓没有该方法的调用点。
    ///
    /// 两个阴影开关都走 `bool_from_int`（值当整数解析后取 `> 0`），并标了 `default`
    /// （缺键即假）；`angles` / `scale` / `model` / `origin` / `color` 没有 `default`，
    /// 缺一即整条解析失败。
    #[derive(Debug, Clone, Deserialize)]
    pub struct PropDynamic<'a> {
        pub angles: Angles,
        #[serde(rename = "disablereceiveshadows", default)]
        #[serde(deserialize_with = "bool_from_int")]
        pub disable_receive_shadows: bool,
        #[serde(rename = "disableshadows", default)]
        #[serde(deserialize_with = "bool_from_int")]
        pub disable_shadows: bool,
        /// 键 `modelscale`：模型缩放，必需字段。
        #[serde(rename = "modelscale")]
        pub scale: f32,
        /// 模型路径，借用实体原文（不复制成 `String`）。
        pub model: &'a str,
        pub origin: Vector,
        #[serde(rename = "rendercolor")]
        pub color: Color,
        /// 键 `targetname`：实体名，缺键为 `None`。
        #[serde(rename = "targetname", default)]
        pub name: Option<&'a str>,
        /// 键 `parentname`：父实体名，缺键为 `None`。
        #[serde(rename = "parentname", default)]
        pub parent: Option<&'a str>,
    }

    /// `prop_dynamic_override` 实体：字段与 `PropDynamic` 逐项同名同类型。
    ///
    /// 之所以单独一个结构体，是为了在枚举里区分 classname；`src/wasm-core/vbsp/data/mod.rs`
    /// 为它写了与 `PropDynamic` 内容相同的第二份 `as_prop_placement`，两者要一起改。
    #[derive(Debug, Clone, Deserialize)]
    pub struct PropDynamicOverride<'a> {
        pub angles: Angles,
        #[serde(rename = "disablereceiveshadows", default)]
        #[serde(deserialize_with = "bool_from_int")]
        pub disable_receive_shadows: bool,
        #[serde(rename = "disableshadows", default)]
        #[serde(deserialize_with = "bool_from_int")]
        pub disable_shadows: bool,
        #[serde(rename = "modelscale")]
        pub scale: f32,
        pub model: &'a str,
        pub origin: Vector,
        #[serde(rename = "rendercolor")]
        pub color: Color,
        #[serde(rename = "targetname", default)]
        pub name: Option<&'a str>,
        #[serde(rename = "parentname", default)]
        pub parent: Option<&'a str>,
    }

    /// `env_sprite` 实体：位置、缩放、贴图与颜色，四个字段都必需。
    ///
    /// 缩放键是 `scale`（**没有** rename），与 `PropDynamic` 的 `modelscale` 不是同一个键。
    #[derive(Debug, Clone, Deserialize)]
    pub struct EnvSprite<'a> {
        pub origin: Vector,
        /// 键 `scale`。
        pub scale: f32,
        pub model: &'a str,
        #[serde(rename = "rendercolor")]
        pub color: Color,
    }

    /// `info_player_teamspawn` 实体：出生点。
    ///
    /// 本仓三个工程的导出层都不用这个结构体选出生点——`apps/viewer/crates/wasm/src/lib.rs`
    /// 是按 `RawEntity::prop("classname")` 自行筛 classname 的。
    #[derive(Debug, Clone, Deserialize)]
    pub struct Spawn<'a> {
        pub origin: Vector,
        pub angles: Angles,
        /// 键 `targetname`：出生点名字，缺键为 `None`。
        #[serde(rename = "targetname", default)]
        pub target: Option<&'a str>,
        #[serde(rename = "controlpoint", default)]
        pub control_point: Option<&'a str>,
        #[serde(rename = "startdisabled", default)]
        #[serde(deserialize_with = "bool_from_int")]
        pub start_disabled: bool,
        /// 键 `teamnum`：队伍号，必需字段。
        #[serde(rename = "teamnum")]
        pub team: u8,
    }

    /// `func_respawnroom` 实体：重生室的体积与归属队伍。
    ///
    /// 与 `Regenerate` 的分工：本结构体只描述重生室本身，`associatedmodel` 在 `Regenerate` 上。
    #[derive(Debug, Clone, Deserialize)]
    pub struct RespawnRoom<'a> {
        #[serde(rename = "targetname", default)]
        pub target: Option<&'a str>,
        pub model: &'a str,
        #[serde(rename = "startdisabled", default)]
        #[serde(deserialize_with = "bool_from_int")]
        pub start_disabled: bool,
        #[serde(rename = "teamnum")]
        pub team: u8,
    }

    /// `func_regenerate` 实体：补给柜，`associatedmodel` 指向它所属的重生室模型。
    ///
    /// 三个字段都必需，没有 `default`。
    #[derive(Debug, Clone, Deserialize)]
    pub struct Regenerate<'a> {
        /// 键 `associatedmodel`：关联的（重生室）模型。
        #[serde(rename = "associatedmodel")]
        pub associated_model: &'a str,
        pub model: &'a str,
        #[serde(rename = "teamnum")]
        pub team: u8,
    }

    /// `func_door` 实体：门的速度与运动方向。
    ///
    /// 注意 `target` 的类型与其他结构体不同：这里是 `&'a str` 配 `default`，缺键时得到空串
    /// 而不是 `None`；同名键在 `Spawn` / `ObserverPoint` 等处是 `Option<&'a str>`。
    #[derive(Debug, Clone, Deserialize)]
    pub struct Door<'a> {
        pub origin: Vector,
        /// 键 `targetname`：缺键时是空串（`&str` 的 `Default`），不是 `None`。
        #[serde(rename = "targetname", default)]
        pub target: &'a str,
        /// 键 `speed`：开门速度，必需字段。
        pub speed: f32,
        #[serde(rename = "forceclosed", default)]
        #[serde(deserialize_with = "bool_from_int")]
        pub force_closed: bool,
        /// 键 `movedir`：开门方向向量（`"x y z"`）。
        #[serde(rename = "movedir")]
        pub move_direction: Vector,
        pub model: &'a str,
    }

    /// 弹药补给品的载荷：只有 `origin`。
    ///
    /// 被 `Entity` 的 3 个变体共用；与 `HealthPack` 字段集完全相同，两者的区别只在 classname
    /// 标签上。
    #[derive(Debug, Clone, Deserialize)]
    pub struct AmmoPack {
        pub origin: Vector,
    }

    /// 医疗补给品的载荷：只有 `origin`。
    ///
    /// 被 `Entity` 的 3 个变体共用；与 `AmmoPack` 字段集完全相同。
    #[derive(Debug, Clone, Deserialize)]
    pub struct HealthPack {
        pub origin: Vector,
    }

    /// `worldspawn` 实体：整张图的全局参数。
    ///
    /// 键名与世界坐标包围盒的字段名不一致（`world_mins` / `world_maxs`），天空盒键是
    /// `skyname`、版本键是 `mapversion`。只有 `comment` 允许缺键。
    #[derive(Debug, Clone, Deserialize)]
    pub struct WorldSpawn<'a> {
        /// 键 `world_mins`：世界包围盒最小角。
        #[serde(rename = "world_mins")]
        pub min: Vector,
        /// 键 `world_maxs`：世界包围盒最大角。
        #[serde(rename = "world_maxs")]
        pub max: Vector,
        #[serde(rename = "detailvbsp")]
        pub detail_vbsp: &'a str,
        #[serde(rename = "detailmaterial")]
        pub detail_material: &'a str,
        /// 键 `comment`：未写 rename，缺键为 `None`。
        #[serde(default)]
        pub comment: Option<&'a str>,
        #[serde(rename = "skyname")]
        pub skybox: &'a str,
        /// 键 `mapversion`：地图版本号。
        #[serde(rename = "mapversion")]
        pub version: u32,
    }

    /// `info_observer_point` 实体：观察者（摄像机）点位。
    ///
    /// `parent` 是可选父实体，与 `PropDynamic::parent` 同键 `parentname`。
    #[derive(Debug, Clone, Deserialize)]
    pub struct ObserverPoint<'a> {
        #[serde(rename = "startdisabled", default)]
        #[serde(deserialize_with = "bool_from_int")]
        pub start_disabled: bool,
        pub angles: Angles,
        pub origin: Vector,
        #[serde(rename = "targetname", default)]
        pub target: Option<&'a str>,
        #[serde(rename = "parentname", default)]
        pub parent: Option<&'a str>,
    }

    /// 四个刷子实体（`func_brush` / `func_illusionary` / `func_wall` / `func_wall_toggle`）
    /// 共用的字段集。
    ///
    /// **这是本仓唯一被生产路径读取的载荷**：`src/wasm-core/bsp_to_gltf_core/convert.rs` 的
    /// `bsp_models` 取它的 `model` 与 `origin`，其中 `model` 按 `"*N"` 去掉首字符后解析成
    /// `Bsp.models` 的下标。
    #[derive(Debug, Clone, Deserialize)]
    pub struct BrushEntity<'a> {
        /// 形如 `"*12"` 的模型引用；首字符是 `*`，其余部分是 `Bsp.models` 的下标。
        pub model: &'a str,
        /// 世界坐标；作为该模型的整体平移量。
        pub origin: Vector,
        #[serde(rename = "startdisabled", default)]
        #[serde(deserialize_with = "bool_from_int")]
        pub start_disabled: bool,
        #[serde(rename = "rendercolor")]
        pub color: Color,
    }

    /// `env_lightglow` 实体：光晕的尺寸、颜色与可见距离。
    ///
    /// 两个尺寸字段的键名不对称：纵向是 `verticalglowsize`，横向的键字面量是
    /// `horizontalhlowsize`（多一个 `h`），改名时要连实体文本一起改。
    /// 距离字段用 `u32`（`mindist` / `maxdist`），不是浮点。
    #[derive(Debug, Clone, Deserialize)]
    pub struct LightGlow {
        pub origin: Vector,
        #[serde(rename = "verticalglowsize")]
        pub vertical_size: u32,
        /// 键 `horizontalhlowsize`（注意拼写与 `verticalglowsize` 不对称）。
        #[serde(rename = "horizontalhlowsize")]
        pub horizontal_size: u32,
        #[serde(rename = "startdisabled", default)]
        #[serde(deserialize_with = "bool_from_int")]
        pub start_disabled: bool,
        #[serde(rename = "rendercolor")]
        pub color: Color,
        #[serde(rename = "mindist")]
        pub min_distance: u32,
        #[serde(rename = "maxdist")]
        pub max_distance: u32,
    }

    /// `trigger_multiple` 实体：触发区域与五个输出事件名。
    ///
    /// 输出键是连写的小写名（`onstarttouch` / `onstarttouchall` / `onendtouch` /
    /// `onendtouchall` / `onnottouching`），值按字符串原样保留，不解析成
    /// `target,input,param,delay,times` 这类结构。
    /// `wait` 没有 rename、也没有 `default`，键名就是 `wait`。
    #[derive(Debug, Clone, Deserialize)]
    pub struct TriggerMultiple<'a> {
        pub model: &'a str,
        pub origin: Vector,
        #[serde(rename = "onstarttouch", default)]
        pub start_touch: Option<&'a str>,
        #[serde(rename = "onstarttouchall", default)]
        pub start_touch_all: Option<&'a str>,
        #[serde(rename = "onendtouch", default)]
        pub end_touch: Option<&'a str>,
        #[serde(rename = "onendtouchall", default)]
        pub end_touch_all: Option<&'a str>,
        #[serde(rename = "onnottouching", default)]
        pub not_touching: Option<&'a str>,
        #[serde(rename = "targetname", default)]
        pub target_name: Option<&'a str>,
        /// 键 `filtername`：过滤器实体名。
        #[serde(rename = "filtername", default)]
        pub filter: Option<&'a str>,
        /// 键 `wait`：重复触发的间隔；本字段既无 rename 也无 `default`。
        pub wait: Option<u32>,
        #[serde(rename = "startdisabled", default)]
        #[serde(deserialize_with = "bool_from_int")]
        pub start_disabled: bool,
    }

    /// `filter_activator_tfteam` 实体：按队伍判定的过滤器。
    ///
    /// `team` 这里标了 `default`，缺键时是 0，与其他结构体里必需的 `teamnum` 写法不同。
    #[derive(Debug, Clone, Deserialize)]
    pub struct FilterActivatorTeam<'a> {
        pub origin: Vector,
        #[serde(rename = "targetname", default)]
        pub target_name: Option<&'a str>,
        /// 键 `negated`：取反标记，按字符串原样保留（不按布尔解析）。
        #[serde(rename = "negated", default)]
        pub negated: Option<&'a str>,
        #[serde(rename = "teamnum", default)]
        pub team: u8,
    }

    /// `logic_relay` 实体：中继一个输出事件。
    ///
    /// 输出键是 `ontrigger`（连写），不是 `onTrigger`。
    #[derive(Debug, Clone, Deserialize)]
    pub struct LogicRelay<'a> {
        pub origin: Vector,
        #[serde(rename = "targetname", default)]
        pub target_name: Option<&'a str>,
        #[serde(rename = "ontrigger", default)]
        pub on_trigger: Option<&'a str>,
    }

    /// `logic_auto` 实体：地图载入时触发一次。
    ///
    /// 输出键是 `onmapspawn`；本结构体没有 `targetname` 字段。
    #[derive(Debug, Clone, Deserialize)]
    pub struct LogicAuto<'a> {
        pub origin: Vector,
        #[serde(rename = "onmapspawn", default)]
        pub on_map_spawn: Option<&'a str>,
    }

    /// `func_dustmotes` 实体：尘埃粒子区域的形状与密度。
    ///
    /// `origin` 是全文件唯一标了 `default` 的 `origin` 字段（缺键落成零向量），
    /// `model` 仍然必需。
    #[derive(Debug, Clone, Deserialize)]
    pub struct DustMotes<'a> {
        /// 键 `origin`：本文件唯一允许缺省的 `origin`。
        #[serde(default)]
        pub origin: Vector,
        pub model: &'a str,
        #[serde(rename = "startdisabled", default)]
        #[serde(deserialize_with = "bool_from_int")]
        pub start_disabled: bool,
        /// 键 `color`（不是 `rendercolor`）。
        #[serde(rename = "color")]
        pub color: Color,
        #[serde(rename = "spawnrate")]
        pub spawn_rate: u32,
        #[serde(rename = "sizemin")]
        pub size_min: u32,
        #[serde(rename = "sizemax")]
        pub size_max: u32,
        /// 键 `alpha`：按 `u8` 解析，取值上限 255。
        #[serde(rename = "alpha")]
        pub alpha: u8,
    }

    /// `sky_camera` 实体：3D 天空盒相机与雾参数。
    ///
    /// 只有 `fogcolor2` 标了 `default`，其余字段都必需。`fog` / `use_angles` 走
    /// `bool_from_int`，值必须是 0..=255 的整数；`fogcolor2` 是可选的第二种雾色，缺键为 `None`。
    /// `use_angles` 没有 rename，键名带下划线，与其它字段的连写风格不同。
    #[derive(Debug, Clone, Deserialize)]
    pub struct SkyCamera {
        pub origin: Vector,
        /// 键 `fogenable`：雾开关，按整数解析后取 `> 0`。
        #[serde(rename = "fogenable")]
        #[serde(deserialize_with = "bool_from_int")]
        pub fog: bool,
        /// 键 `use_angles`：是否用实体角度，按整数解析后取 `> 0`。
        #[serde(deserialize_with = "bool_from_int")]
        pub use_angles: bool,
        #[serde(rename = "fogstart")]
        pub fog_start: f32,
        #[serde(rename = "fogend")]
        pub fog_end: f32,
        pub angles: Angles,
        /// 键 `fogdir`：雾方向向量。
        #[serde(rename = "fogdir")]
        pub direction: Vector,
        /// 键 `scale`：天空盒缩放，按 `u32` 解析。
        pub scale: u32,
        #[serde(rename = "fogcolor")]
        pub color: Color,
        /// 键 `fogcolor2`：第二种雾色，可选。
        #[serde(rename = "fogcolor2", default)]
        pub color2: Option<Color>,
    }

    /// `path_track` 实体：路径节点，链向下一个节点。
    ///
    /// 两个"目标"字段并存且含义不同：`target`（键 `target`）指向路径上的下一个 `path_track`，
    /// `target_name`（键 `targetname`）是本节点自己的名字。
    #[derive(Debug, Clone, Deserialize)]
    pub struct PathTrack<'a> {
        pub origin: Vector,
        /// 键 `target`：下一个路径节点，缺键为 `None`。
        #[serde(default)]
        pub target: Option<&'a str>,
        #[serde(rename = "targetname", default)]
        pub target_name: Option<&'a str>,
        #[serde(rename = "orientationtype", default)]
        pub orientation_type: u8,
        pub angles: Angles,
        /// 键 `radius`：到达判定半径。
        pub radius: f32,
        /// 键 `speed`：移动速度。
        pub speed: f32,
    }

    /// `env_soundscape_proxy` 实体：把一片区域代理到另一个音景。
    ///
    /// 三个字段都必需；音景名键是连写的 `mainsoundscapename`。
    #[derive(Debug, Clone, Deserialize)]
    pub struct SoundScapeProxy<'a> {
        pub origin: Vector,
        /// 键 `radius`：代理半径。
        pub radius: f32,
        #[serde(rename = "mainsoundscapename")]
        pub main_name: &'a str,
    }

    /// `func_respawnroomvisualizer` 实体：重生室边界的可视面。
    ///
    /// `solid_to_enemies` 没有 rename，键名带下划线；它走 `bool_from_int`（整数解析后取
    /// `> 0`），且没有 `default`，缺键会让整条解析失败。
    #[derive(Debug, Clone, Deserialize)]
    pub struct RespawnVisualizer<'a> {
        pub origin: Vector,
        #[serde(rename = "respawnroomname")]
        pub room_name: &'a str,
        #[serde(rename = "rendercolor")]
        pub color: Color,
        /// 键 `solid_to_enemies`。
        #[serde(deserialize_with = "bool_from_int")]
        pub solid_to_enemies: bool,
    }

    /// `info_particle_system` 实体：粒子系统的挂点与效果名。
    ///
    /// `target_name` 没有 `default`，但类型是 `Option<&'a str>`（缺键即 `None`）；
    /// `start_active` 标了 `default` 并走 `bool_from_int`，缺键即假。
    #[derive(Debug, Clone, Deserialize)]
    pub struct ParticleSystem<'a> {
        pub origin: Vector,
        pub angles: Angles,
        #[serde(rename = "targetname")]
        pub target_name: Option<&'a str>,
        /// 键 `effect_name`（没有 rename，键名带下划线）。
        pub effect_name: &'a str,
        #[serde(default)]
        #[serde(deserialize_with = "bool_from_int")]
        pub start_active: bool,
    }

    /// `team_control_point` 实体：TF 的占领点。
    ///
    /// 图标与模型字段只列了 0 / 2 / 3 号队伍，**没有 1 号**；`team_model_*` / `team_icon_*` /
    /// `point_warn_sound` 全是必需字段，任一缺失都会让整条解析失败。
    #[derive(Debug, Clone, Deserialize)]
    pub struct TeamControlPoint<'a> {
        pub origin: Vector,
        pub angles: Angles,
        #[serde(rename = "targetname")]
        pub target_name: &'a str,
        pub point_warn_sound: &'a str,
        pub team_model_0: &'a str,
        pub team_model_2: &'a str,
        pub team_model_3: &'a str,
        pub team_icon_0: &'a str,
        pub team_icon_2: &'a str,
        pub team_icon_3: &'a str,
        #[serde(default)]
        pub point_default_owner: u8,
        #[serde(rename = "startdisabled", default)]
        #[serde(deserialize_with = "bool_from_int")]
        pub start_disabled: bool,
    }

    /// `func_areaportal` 实体：区域门户的编号与初始开关状态。
    ///
    /// 没有 `origin`：门户本身靠编号与 brush 关联，`start_open` 走 `bool_from_int` 且无
    /// `default`，必须出现在实体里。
    #[derive(Debug, Clone, Deserialize)]
    pub struct AreaPortal {
        /// 键 `portalversion`：门户版本号。
        #[serde(rename = "portalversion")]
        pub version: u8,
        /// 键 `portalnumber`：门户编号。
        #[serde(rename = "portalnumber")]
        pub number: u8,
        /// 键 `startopen`：初始是否开启，按整数解析后取 `> 0`。
        #[serde(rename = "startopen")]
        #[serde(deserialize_with = "bool_from_int")]
        pub start_open: bool,
    }

    /// `game_text` 实体：屏幕文字的排版参数。
    ///
    /// 键名与字段名有多处不一致：`fadein` 对应 `fade_in`、`holdtime` 对应 `hold_time`、
    /// `fxtime` 对应 `fx_time`，而 `fadeout` / `message` / `color` / `x` / `y` / `channel`
    /// 直接同名。只有 `targetname` 允许缺键。
    #[derive(Debug, Clone, Deserialize)]
    pub struct GameText<'a> {
        pub origin: Vector,
        #[serde(rename = "targetname", default)]
        pub target_name: Option<&'a str>,
        /// 键 `message`：要显示的文本。
        pub message: &'a str,
        /// 键 `fadeout`：淡出时长（秒）。
        pub fadeout: f32,
        /// 键 `color`：文字颜色。
        pub color: Color,
        /// 键 `fadein`：淡入时长（秒）。
        #[serde(rename = "fadein")]
        pub fade_in: f32,
        /// 键 `x`：归一化横坐标。
        pub x: f32,
        /// 键 `y`：归一化纵坐标。
        pub y: f32,
        /// 键 `holdtime`：停留时长（秒）。
        #[serde(rename = "holdtime")]
        pub hold_time: f32,
        /// 键 `fxtime`：特效时长（秒）。
        #[serde(rename = "fxtime")]
        pub fx_time: f32,
        /// 键 `channel`：文字通道号，按 `u8` 解析。
        pub channel: u8,
    }

    /// `keyframe_rope` 实体：绳索的关键帧节点（`move_rope` 的下一跳）。
    ///
    /// 四个布尔字段（`dangling` / `barbed` / `breakable` / `collide`）都走 `bool_from_int`
    /// 且都没有 `default`，实体里缺任一个都会让整条解析失败。`sub_div` 的键是连写的 `subdiv`。
    #[derive(Debug, Clone, Deserialize)]
    pub struct RopeKeyFrame<'a> {
        pub origin: Vector,
        #[serde(rename = "targetname", default)]
        pub target_name: Option<&'a str>,
        /// 键 `ropematerial`：绳索材质。
        #[serde(rename = "ropematerial")]
        pub material: &'a str,
        /// 键 `dangling`：是否自然下垂。
        #[serde(rename = "dangling")]
        #[serde(deserialize_with = "bool_from_int")]
        pub dangling: bool,
        /// 键 `barbed`：是否带刺。
        #[serde(rename = "barbed")]
        #[serde(deserialize_with = "bool_from_int")]
        pub barbed: bool,
        /// 键 `breakable`：是否可断。
        #[serde(rename = "breakable")]
        #[serde(deserialize_with = "bool_from_int")]
        pub breakable: bool,
        #[serde(rename = "texturescale")]
        pub texture_scale: f32,
        /// 键 `collide`：是否与玩家碰撞。
        #[serde(rename = "collide")]
        #[serde(deserialize_with = "bool_from_int")]
        pub collide: bool,
        /// 键 `width`：绳宽。
        #[serde(rename = "width")]
        pub width: f32,
        /// 键 `slack`：松弛量。
        #[serde(rename = "slack")]
        pub slack: f32,
        #[serde(rename = "movespeed")]
        pub move_speed: f32,
        /// 键 `subdiv`：细分段数，按 `u8` 解析。
        #[serde(rename = "subdiv")]
        pub sub_div: u8,
    }

    /// `move_rope` 实体：绳索的起点，字段是 `RopeKeyFrame` 的超集再加节点链接信息。
    ///
    /// 比 `RopeKeyFrame` 多出 `positioninterpolator` / `type` / `nextkey` 三个键，且三个布尔
    /// 字段同样走 `bool_from_int` 且无 `default`。`next_key` 是 `&'a str`（必需）；
    /// `ty` 的键名是 Rust 关键字 `type`，故字段改名。
    #[derive(Debug, Clone, Deserialize)]
    pub struct RopeMove<'a> {
        pub origin: Vector,
        #[serde(rename = "ropematerial")]
        pub material: &'a str,
        #[serde(rename = "texturescale")]
        pub texture_scale: f32,
        #[serde(rename = "slack")]
        pub slack: f32,
        #[serde(rename = "width")]
        pub width: f32,
        #[serde(rename = "dangling")]
        #[serde(deserialize_with = "bool_from_int")]
        pub dangling: bool,
        #[serde(rename = "barbed")]
        #[serde(deserialize_with = "bool_from_int")]
        pub barbed: bool,
        #[serde(rename = "breakable")]
        #[serde(deserialize_with = "bool_from_int")]
        pub breakable: bool,
        /// 键 `positioninterpolator`：位置插值方式，按 `u8` 解析。
        #[serde(rename = "positioninterpolator")]
        pub interpolator: u8,
        #[serde(rename = "movespeed")]
        pub move_speed: f32,
        /// 键 `type`：绳索类型，按 `u8` 解析（字段名让开了 Rust 关键字）。
        #[serde(rename = "type")]
        pub ty: u8,
        /// 键 `nextkey`：下一个 `keyframe_rope` 的名字。
        #[serde(rename = "nextkey")]
        pub next_key: &'a str,
        #[serde(rename = "subdiv")]
        pub sub_div: u8,
    }

    /// `tf_gamerules` 实体：TF 规则开关。
    ///
    /// `origin` 是唯一必需的字段；`target_name` 标了 `default`（缺键为 `None`），
    /// `ctf_overtime` 走 `bool_from_int` 并标 `default`（缺键为假），`hud_type` 是普通
    /// `u32` 且标 `default`（缺键为 0）。
    #[derive(Debug, Clone, Deserialize)]
    pub struct GameRules<'a> {
        pub origin: Vector,
        #[serde(rename = "targetname", default)]
        pub target_name: Option<&'a str>,
        /// 键 `ctf_overtime`：加时赛开关，按整数解析后取 `> 0`。
        #[serde(default)]
        #[serde(deserialize_with = "bool_from_int")]
        pub ctf_overtime: bool,
        /// 键 `hud_type`：HUD 样式号。
        #[serde(default)]
        pub hud_type: u32,
    }

    /// `tf_logic_koth` 实体：山丘之王模式的计时参数。
    ///
    /// 三个字段都必需，没有 `default`。
    #[derive(Debug, Clone, Deserialize)]
    pub struct KothLogic {
        pub origin: Vector,
        /// 键 `unlock_point`：解锁所需占点数。
        pub unlock_point: u32,
        /// 键 `timer_length`：计时长度。
        pub timer_length: u32,
    }

    /// `ambient_generic` 实体：环境音源。
    ///
    /// 是三个标了 `rename_all = "lowercase"` 的结构体之一。绝大多数数值字段都标了 `default`，
    /// 只有 `origin` 与 `message`（声音路径）没有 `default`，缺任一个即整条解析失败；与
    /// `message` 一样没有 rename 的还有 `origin` / `radius` / `preset` / `pitch` / `health`。
    /// 键名风格不统一：`spin_up` / `lfo_type` / `lfo_rate` / `lfo_mod_vol` / `pitch_start`
    /// 带下划线，而 `lfomodpitch` / `fadeoutsec` / `fadeinsec` / `cspinup` / `volstart` /
    /// `spawn_flags` 是连写。
    #[derive(Debug, Clone, Deserialize)]
    #[serde(rename_all = "lowercase")]
    pub struct AmbientGeneric<'a> {
        pub origin: Vector,
        /// 键 `volstart`：初始音量。
        #[serde(rename = "volstart", default)]
        pub volume_start: f32,
        #[serde(rename = "spin_up", default)]
        pub spin_up: f32,
        #[serde(rename = "spin_down", default)]
        pub spin_down: f32,
        #[serde(rename = "spawn_flags", default)]
        pub spawn_flags: u32,
        /// 键 `radius`：可听半径。
        #[serde(rename = "radius", default)]
        pub radius: f32,
        /// 键 `preset`：预设音效号。
        #[serde(rename = "preset", default)]
        pub preset: u32,
        #[serde(rename = "pitch_start", default)]
        pub pitch_start: f32,
        /// 键 `pitch`：音高。
        #[serde(rename = "pitch", default)]
        pub pitch: f32,
        /// 键 `message`：声音路径，本结构体唯一必需字段。
        pub message: &'a str,
        #[serde(rename = "lfo_type", default)]
        pub lfo_type: u32,
        #[serde(rename = "lfo_rate", default)]
        pub lfo_rate: u32,
        #[serde(rename = "lfo_mod_vol", default)]
        pub lfo_mod_vol: f32,
        /// 键 `lfomodpitch`（与上面的 `lfo_*` 不同，是连写）。
        #[serde(rename = "lfomodpitch", default)]
        pub lfo_mod_pitch: f32,
        /// 键 `health`：可被摧毁所需血量，按 `u8` 解析。
        #[serde(rename = "health", default)]
        pub health: u8,
        #[serde(rename = "fadeoutsec", default)]
        pub fade_out_secs: f32,
        #[serde(rename = "fadeinsec", default)]
        pub fade_in_secs: f32,
        #[serde(rename = "cspinup", default)]
        pub c_spin_up: f32,
    }

    /// `logic_case` 实体：按分支号触发不同输出。
    ///
    /// 五个分支键是补零的连写名（`oncase01` .. `oncase05`）；这五个字段与 `target_name`
    /// 都没有 `default`，但类型是 `Option<&'a str>`，缺键时落成 `None`。是三个
    /// `rename_all = "lowercase"` 结构体之一。
    #[derive(Debug, Clone, Deserialize)]
    #[serde(rename_all = "lowercase")]
    pub struct LogicCase<'a> {
        pub origin: Vector,
        #[serde(rename = "targetname")]
        pub target_name: Option<&'a str>,
        /// 键 `oncase01`。
        #[serde(rename = "oncase01")]
        pub oncase_01: Option<&'a str>,
        /// 键 `oncase02`。
        #[serde(rename = "oncase02")]
        pub oncase_02: Option<&'a str>,
        /// 键 `oncase03`。
        #[serde(rename = "oncase03")]
        pub oncase_03: Option<&'a str>,
        /// 键 `oncase04`。
        #[serde(rename = "oncase04")]
        pub oncase_04: Option<&'a str>,
        /// 键 `oncase05`。
        #[serde(rename = "oncase05")]
        pub oncase_05: Option<&'a str>,
    }

    /// `func_occluder` 实体：遮挡体，用于剔除。
    ///
    /// 三个字段里 `occludernumber` 是唯一标了 `default` 的；`start_active` 走
    /// `bool_from_int` 且没有 `default`，实体里必须出现。是三个
    /// `rename_all = "lowercase"` 结构体之一。
    #[derive(Debug, Clone, Deserialize)]
    #[serde(rename_all = "lowercase")]
    pub struct Occluder<'a> {
        #[serde(rename = "occludernumber", default)]
        pub occluder_number: u32,
        pub model: &'a str,
        /// 键 `startactive`：初始是否启用。
        #[serde(rename = "startactive", deserialize_with = "bool_from_int")]
        pub start_active: bool,
    }

    /// serde 字段级布尔解码器：把值当 `u8` 解析，再取 `> 0`。
    ///
    /// 与 `EntityProp for bool` 的 `raw != "0"` 不是同一套口径：本函数对非数字值
    /// （`"false"`、空串）直接报错，值超过 255 也报错；而 `"2"` / `"255"` 都是真，
    /// `"0"` / `"00"` 都是假。
    ///
    /// 私有函数，`pub use typed::*` 不会把它转出；只在 26 处 `deserialize_with` 里按名字引用。
    fn bool_from_int<'de, D: Deserializer<'de>>(deserializer: D) -> Result<bool, D::Error> {
        let int = u8::deserialize(deserializer)?;
        Ok(int > 0)
    }
}
