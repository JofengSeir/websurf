//! BSP 记录的只读句柄（`Handle`）：把"某条记录"与"它所属的 `Bsp`"打包成一个可解引用的值。
//!
//! 上游：`vbsp/mod.rs` 的 `Bsp` 造句柄——单条用 `leaf` / `plane` / `face` / `node` / `displacement`，
//! 批量用 `models()` / `textures()` / `static_props()`。
//! 下游：`bsp_to_gltf_core/convert.rs`（模型 → GLB 图元：`model.faces()` → `is_visible()` /
//! `vertex_positions()`，纹理坐标走 `TextureInfo::uv`）、`mosaic/manifest.rs`（面 → 纹理名清单）、
//! 三工程 `crates/wasm` 的静态道具导出（`static_props()` 的 `model()` / `origin` / `angles()` / `skin`）。
//!
//! 职责：把"记录 → 其它表"的取值规则集中在一处：① 下标解引用（`Face::texture_info` → `textures_info`、
//! `Node::plane_index` → `planes`、`TextureData::name_string_table_id` → 纹理名字节）；
//! ② 表区间迭代（`Model::faces` 按 `first_face` / `face_count` 切 `faces`，`Leaf::faces` 按
//! `first_leaf_face` / `leaf_face_count` 切 `leaf_faces`）；③ displacement 面的细分与三角化；
//! ④ 纹理 UV 求值。
//!
//! 关键不变量与坑：
//! - 句柄同时持 `&Bsp` 与 `&T`，两者**共用同一个生命周期参数**：`Handle::new(bsp: &'a Bsp, data: &'a T)`。
//!   因此句柄存活期间 `Bsp` 整体处于不可变借用，拿不到 `&mut Bsp`；`data` 也一定活在 `Bsp` 内。
//! - 读表方式不统一，失败行为因此分三类：`TextureInfo::texture_data`、`Face::texture`、
//!   `Face::normal`、`StaticPropLump::model` 是**直接下标**（越界 panic）；
//!   `Face::vertices` / `vertex_indexes` 是 `get(..).unwrap()`（同样 panic）；
//!   `Leaf::faces`、`DisplacementInfo` 的邻居与顶点则用 `filter_map` / `flat_map` **静默丢弃**越界项，
//!   于是迭代出的条数可以少于记录里声明的条数。
//! - 表区间切片（`Model::faces`、`Leaf::faces`）不做长度检查，越界即 panic。`Bsp::validate` 覆盖
//!   face→texture_info、texture_info→texture_data、node→plane、node→leaf、edge→vertex、
//!   static prop→模型名，但**不覆盖** model→faces、leaf→leaf_faces、face→plane。
//! - `DisplacementInfo::corner_positions` 要求对应面恰好 4 个顶点（`ArrayVec<_, 4>` + `try_into`）；
//!   细分顶点数是 `(2^power + 1)^2`，`triangulated_displaced_vertices` 按这个尺寸直接下标取点，
//!   顶点缺失即 panic 而不是少出三角形。
//! - `Leaf::visible_set` 走 `VisData::visible_clusters`，那里对 `pvs_offsets`、`data` 与结果位图
//!   都是直接下标：调用方须保证 `cluster < pvs_offsets.len()`，且所有 leaf 的
//!   `cluster < VisData::cluster_count`。
//!
//! 边界：只读访问。不改 `Bsp`、不缓存、不做校验（校验在 `Bsp::read` 收尾的 `validate`），
//! 也不解析 lump 字节（那是 `reader.rs` 与 `data/**` 的职责）。
//!
//! 测试归属：本文件无 `#[test]`。

// 本模块与 `vbsp/mod.rs` 一样保留完整解析面，其中一部分项没有被三个工程取用。
#![allow(dead_code)]

use crate::vbsp::data::*;
use crate::vbsp::Bsp;
use arrayvec::ArrayVec;
use itertools::Either;
use ahash::RandomState;
use std::fmt::{Debug, Formatter};
use std::hash::BuildHasher;
use std::hash::{Hash, Hasher};
use std::ops::Deref;

/// 一条 BSP 记录 + 它所属的 `Bsp`，成对打包的只读句柄。
///
/// 为什么必须带 `bsp`：记录里存的是**别的表的绝对下标**（`Face::texture_info`、`Node::plane_index`、
/// `TextureData::name_string_table_id`、`SurfaceEdge::edge` 等），只有拿到 `Bsp` 才能把下标解成数据。
///
/// 生命周期：`bsp` 与 `data` 共用同一个 `'a`（见 `Handle::new`），所以 `data` 一定是 `bsp` 内部的
/// 一条记录，句柄不会比 `Bsp` 活得久。`Deref` 到 `T`，字段可以像普通引用一样读。
pub struct Handle<'a, T> {
    bsp: &'a Bsp,
    data: &'a T,
}

/// `Debug` 只打印 `data`，`bsp` 由 `finish_non_exhaustive` 略去（否则会打印整棵树）。
impl<T: Debug> Debug for Handle<'_, T> {
    fn fmt(&self, f: &mut Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Handle")
            .field("data", self.data)
            .finish_non_exhaustive()
    }
}

/// 克隆的是两个引用，所以 `T` 不需要实现 `Clone`。
impl<T> Clone for Handle<'_, T> {
    fn clone(&self) -> Self {
        Handle { ..*self }
    }
}

/// 取出内部记录引用，生命周期取 `'a` 而不是 `&self`：句柄本身被丢弃后该引用仍然有效。
impl<'a, T> AsRef<T> for Handle<'a, T> {
    fn as_ref(&self) -> &'a T {
        self.data
    }
}

/// 解引用到记录本体：字段读取与记录类型上的方法都由此生效。
impl<T> Deref for Handle<'_, T> {
    type Target = T;

    fn deref(&self) -> &Self::Target {
        self.data
    }
}

impl<'a, T> Handle<'a, T> {
    /// 把一条记录与它所属的 `Bsp` 打包。
    ///
    /// `bsp` 必须是 `data` 所在的那个 `Bsp`：本函数不校验这一点，两个参数同生命周期也只是
    /// 编译期约束。传错会让此后所有下标解引用都指向错误的表。
    pub fn new(bsp: &'a Bsp, data: &'a T) -> Self {
        Handle { bsp, data }
    }
}

impl<'a> Handle<'a, Model> {
    /// 组成该模型的面：按 `first_face..first_face + face_count` 切 `Bsp::faces`（`FACES`(7)）。
    ///
    /// 切片不做长度检查，区间越界即 panic，而 `Bsp::validate` **不覆盖** `models` 的区间——
    /// 调用方要自行确认该区间落在面表内。这里也**不**按 `FACES_HDR` 切换：HDR 面表由
    /// `bsp_to_gltf_core/lightmap.rs` 的 `lightmap_faces` 单独选。
    pub fn faces(&self) -> impl Iterator<Item = Handle<'a, Face>> {
        let start = self.first_face as usize;
        let end = start + self.face_count as usize;
        let bsp = self.bsp;

        bsp.faces[start..end]
            .iter()
            .map(move |face| Handle::new(bsp, face))
    }

    /// 纹理迭代器，语义是"全地图纹理"而不是"该模型用到的纹理"：直接转调 `Bsp::textures()`，与 `self` 无关。
    pub fn textures(&self) -> impl Iterator<Item = Handle<'_, TextureInfo>> {
        self.bsp.textures()
    }
}

impl Handle<'_, Node> {
    /// 分割该节点的平面（`Node::plane_index` → `Bsp::planes`）。
    ///
    /// 走 `Bsp::plane` 后 `unwrap()`：下标越界会 panic；`Bsp::validate` 已覆盖 node→plane。
    pub fn plane(&self) -> Handle<'_, Plane> {
        self.bsp.plane(self.plane_index as _).unwrap()
    }
}

impl<'a> Handle<'a, Leaf> {
    /// 该 leaf 可见的其它 leaf；`cluster < 0`（不参与 PVS 的 leaf）返回 `None`。
    ///
    /// 结果**含自身**（`leaf.cluster == cluster` 恒判可见），并且只对 `cluster > 0` 的候选查 PVS
    /// 位图，其余一律判不可见。
    ///
    /// 越界风险集中在 `VisData::visible_clusters`：它按 `pvs_offsets[cluster]` 取行、
    /// 按 `data[offset..]` 取压缩缓冲、结果位图又按 `leaf.cluster` 索引，三处都没有长度检查。
    /// 所以调用方须保证 `cluster` 落在 `pvs_offsets` 内，且所有 leaf 的 `cluster` 小于
    /// `VisData::cluster_count`。
    pub fn visible_set(&self) -> Option<impl Iterator<Item = Handle<'a, Leaf>>> {
        let cluster = self.cluster;
        let bsp = self.bsp;

        if cluster < 0 {
            None
        } else {
            let visible_clusters = bsp.vis_data.visible_clusters(cluster);
            Some(
                bsp.leaves
                    .iter()
                    .filter(move |leaf| {
                        if leaf.cluster == cluster {
                            true
                        } else if leaf.cluster > 0 {
                            visible_clusters[leaf.cluster as u64]
                        } else {
                            false
                        }
                    })
                    .map(move |leaf| Handle { bsp, data: leaf }),
            )
        }
    }

    /// 该 leaf 引用的面：按 `first_leaf_face..first_leaf_face + leaf_face_count` 切 `Bsp::leaf_faces`。
    ///
    /// 两处失败行为不同：切片越界 panic；切出来的 `LeafFace::face` 越界则被 `filter_map` 丢掉，
    /// 所以迭代出的面数可以少于 `leaf_face_count`。这两个区间都不在 `Bsp::validate` 的覆盖范围内。
    pub fn faces(&self) -> impl Iterator<Item = Handle<'a, Face>> {
        let start = self.first_leaf_face as usize;
        let end = start + self.leaf_face_count as usize;
        let bsp = self.bsp;
        bsp.leaf_faces[start..end]
            .iter()
            .filter_map(move |leaf_face| bsp.face(leaf_face.face as usize))
    }
}

impl<'a> Handle<'a, TextureInfo> {
    /// 该 texture_info 指向的纹理元数据（`texture_data_index` → `Bsp::textures_data`）。
    ///
    /// 直接下标，越界 panic；`Bsp::validate` 已覆盖 texture_info→texture_data 这一条。
    pub fn texture_data(&self) -> Handle<'a, TextureData> {
        Handle::new(
            self.bsp,
            &self.bsp.textures_data[self.data.texture_data_index as usize],
        )
    }

    /// 纹理名，转调 `Handle<TextureData>::name`（从字符串表里取 `\0` 前的一段）。
    pub fn name(&self) -> &'a str {
        self.texture_data().name()
    }

    /// 该纹理确定的 3 字节调试色（同名恒定，见 `Handle<TextureData>::debug_color`）。
    pub fn debug_color(&self) -> [u8; 3] {
        self.texture_data().debug_color()
    }

    /// 水平 UV：`(u[0..3] · pos + u[3]) / 宽`，一次线性变换，不做 clamp。
    ///
    /// 分母取 `textures_data` 的 `width`（不是 `view_width`）；该值为 0 时结果是 `inf` / `NaN`，
    /// 本方法不做除零保护。
    pub fn u(&self, pos: Vector) -> f32 {
        (self.texture_transforms_u[0] * pos.x
            + self.texture_transforms_u[1] * pos.y
            + self.texture_transforms_u[2] * pos.z
            + self.texture_transforms_u[3])
            / self.texture_data().width as f32
    }

    /// 垂直 UV：与 `u` 同式，改用 `texture_transforms_v` 与 `textures_data` 的 `height`。
    pub fn v(&self, pos: Vector) -> f32 {
        (self.texture_transforms_v[0] * pos.x
            + self.texture_transforms_v[1] * pos.y
            + self.texture_transforms_v[2] * pos.z
            + self.texture_transforms_v[3])
            / self.texture_data().height as f32
    }

    /// `[u(pos), v(pos)]`；两次变换各自查一次 `texture_data()`（没有缓存）。
    pub fn uv(&self, pos: Vector) -> [f32; 2] {
        [self.u(pos), self.v(pos)]
    }
}

impl<'a> Handle<'a, TextureData> {
    /// 纹理名：`name_string_table_id` 是 `texture_string_data` 里的**字节**偏移，从该处切到
    /// 下一个 `\0`；找不到 `\0` 就取到末尾。
    ///
    /// 取偏移表用的是直接下标，切字符串用的是按字节切片，两者越界都会 panic；偏移落在多字节字符
    /// 中间同样 panic。`Bsp::validate` 只保证该偏移小于 `texture_string_data` 的**字节长度**。
    pub fn name(&self) -> &'a str {
        let start = self.bsp.texture_string_tables[self.name_string_table_id as usize] as usize;
        let part = &self.bsp.texture_string_data[start..];
        if let Some((s, _)) = part.split_once('\0') {
            s
        } else {
            part
        }
    }

    /// 该纹理名哈希出的 3 字节调试色：用 `RandomState::with_seeds(0, 0, 0, 0)` 建哈希器，
    /// 取 64 位哈希**大端**前 3 字节。
    ///
    /// 种子写死，所以同一个名字在本仓任何进程、任何平台上都得到同一颜色（不是随机色）。
    pub fn debug_color(&self) -> [u8; 3] {
        let mut name_hasher = RandomState::with_seeds(0, 0, 0, 0).build_hasher();
        self.name().hash(&mut name_hasher);
        let name_hash = name_hasher.finish().to_be_bytes();
        [name_hash[0], name_hash[1], name_hash[2]]
    }
}



impl<'a> Handle<'a, Face> {
    /// 该面的纹理信息（`texture_info` → `Bsp::textures_info`）。
    ///
    /// `get(..)` 之后 `unwrap()`：越界 panic；`Bsp::validate` 已覆盖这条关系。
    pub fn texture(&self) -> Handle<'a, TextureInfo> {
        self.bsp
            .textures_info
            .get(self.texture_info as usize)
            .map(|texture_info| Handle {
                bsp: self.bsp,
                data: texture_info,
            })
            .unwrap()
    }

    /// 组成该面的顶点：`vertex_indexes()` 的每个下标查一次 `Bsp::vertices`，下标越界 panic。
    pub fn vertices(&self) -> impl Iterator<Item = &'a Vertex> + 'a {
        let bsp = self.bsp;
        self.vertex_indexes()
            .map(move |vert_index| bsp.vertices.get(vert_index as usize).unwrap())
    }

    /// 组成该面的顶点下标（指向 `Bsp::vertices`），沿面的边走一圈。
    ///
    /// 三步查表，任何一步越界都 panic：`first_edge..first_edge + num_edges` 取 `surface_edges`、
    /// `SurfaceEdge::edge_index()`（取绝对值）取 `edges`、再按 `SurfaceEdge::direction()` 在边的
    /// `start_index` / `end_index` 之间二选一。
    ///
    /// 产出的是**逐边**的原始 `u16` 下标，未去重：一条边只贡献一个顶点，
    /// 所以相邻三角形共用的顶点会在结果里重复出现。
    pub fn vertex_indexes(&self) -> impl Iterator<Item = u16> + 'a {
        let bsp = self.bsp;
        (self.data.first_edge..(self.data.first_edge + self.data.num_edges as i32))
            .map(move |surface_edge| bsp.surface_edges.get(surface_edge as usize).unwrap())
            .map(move |surface_edge| {
                bsp.edges
                    .get(surface_edge.edge_index() as usize)
                    .map(|edge| (edge, surface_edge.direction()))
                    .unwrap()
            })
            .map(|(edge, direction)| match direction {
                EdgeDirection::FirstToLast => edge.start_index,
                EdgeDirection::LastToFirst => edge.end_index,
            })
    }

    /// 该面第一条边的方向（`surface_edges[first_edge]`）；直接下标，`first_edge` 越界即 panic。
    pub fn edge_direction(&self) -> EdgeDirection {
        self.bsp.surface_edges[self.first_edge as usize].direction()
    }

    /// 该面是否应当渲染：纹理 `flags` 与 `SKY2D | SKY | TRIGGER | HINT | SKIP | NODRAW` 的交集为空。
    ///
    /// 判据取自 `TextureInfo::flags`，所以要先能取到 texture_info 与 texture_data，
    /// 与它们同样受越界 panic 的影响（见 `texture`）。
    pub fn is_visible(&self) -> bool {
        let texture = self.texture();
        !texture.flags.intersects(
            TextureFlags::SKY2D
                | TextureFlags::SKY
                | TextureFlags::TRIGGER
                | TextureFlags::HINT
                | TextureFlags::SKIP
                | TextureFlags::NODRAW,
        )
    }

    /// 三角扇剖分：取前两个顶点当基准，此后每读一个顶点就与"上一个"和"第一个"组成一个三角形。
    ///
    /// 只适用于顶点已按序排列的凸面。顶点不足 3 个时 `expect("face with <3 points")` panic。
    /// 产出三角形的顶点顺序是 `[c, b, a]`（与输入遍历顺序相反）。
    pub fn triangulate(&self) -> impl Iterator<Item = [Vector; 3]> + 'a {
        let mut vertices = self.vertices();

        let a = vertices.next().expect("face with <3 points");
        let mut b = vertices.next().expect("face with <3 points");

        vertices.map(move |c| {
            let points = [c.position, b.position, a.position];
            b = c;
            points
        })
    }

    /// 该面挂的 displacement（`displacement_info` 为负时 `None`）。
    ///
    /// 走 `Bsp::displacement`，越界只是 `None`，不 panic。
    pub fn displacement(&self) -> Option<Handle<'a, DisplacementInfo>> {
        self.bsp.displacement(self.displacement_info as usize)
    }

    /// 面的顶点位置序列：有 displacement 时用细分后叠加位移的顶点，否则用三角剖分展平的顶点。
    ///
    /// 两条分支都**按三角形展平**（每个三角形 3 个点，共用顶点会重复出现），没有去重，
    /// 也不是"面的唯一顶点集合"——直接拿去当顶点数组会得到重复点。
    pub fn vertex_positions(&self) -> impl Iterator<Item = Vector> + 'a {
        self.displacement()
            .map(|displacement| displacement.triangulated_displaced_vertices())
            .map(Either::Left)
            .unwrap_or_else(|| Either::Right(self.triangulate().flatten()))
    }

    /// 面的平面法线（`plane_num` → `Bsp::planes`）。
    ///
    /// `unwrap()`：`plane_num` 越界 panic，而 `Bsp::validate` **不检查** `face.plane_num`。
    pub fn normal(&self) -> Vector {
        self.bsp.plane(self.plane_num as usize).unwrap().normal
    }
}


impl<'a> Handle<'a, DisplacementInfo> {
    /// 四条边上的子邻居：`edge_neighbours` 是 `[DisplacementNeighbour; 4]`，每条边最多 2 个，
    /// 空槽由 `DisplacementNeighbour::iter` 滤掉。产出的是子邻居本身，不是它指向的 displacement。
    pub fn edge_neighbours(&self) -> impl Iterator<Item = Handle<'a, DisplacementSubNeighbour>> {
        self.data
            .edge_neighbours
            .iter()
            .flat_map(|edge| edge.iter())
            .map(|sub| Handle::new(self.bsp, sub))
    }

    /// 四个角的邻居 displacement；`neighbour_index` 越界的项被 `filter_map` 丢弃，
    /// 因此条数可以少于记录里声明的角邻居数。
    pub fn corner_neighbours(&self) -> impl Iterator<Item = Handle<'a, DisplacementInfo>> {
        self.data
            .corner_neighbours
            .iter()
            .flat_map(|corner| corner.neighbours())
            .filter_map(|id| self.bsp.displacement(id as usize))
    }

    /// 该 displacement 引用的位移顶点：区间是
    /// `displacement_vertex_start..displacement_vertex_start + vertex_count()`，越界项被丢弃。
    ///
    /// `vertex_count()` = `(2^power + 1)^2`，与 `subdivided_face` 的点数一致——两侧靠这个等式对齐。
    pub fn displacement_vertices(&self) -> impl Iterator<Item = Handle<'a, DisplacementVertex>> {
        (self.displacement_vertex_start..(self.displacement_vertex_start + self.vertex_count()))
            .flat_map(|i| self.bsp.displacement_vertex(i as usize))
    }

    /// 该 displacement 挂在哪个面上（`map_face`）；越界返回 `None`。
    pub fn face(&self) -> Option<Handle<'a, Face>> {
        self.bsp.face(self.map_face as usize)
    }

    /// 四个角点的位置：先取该面的 4 个顶点，再旋转数组，使第 0 个是离 `start_position` 最近的那个。
    ///
    /// 两条硬前提：`face().unwrap()`（面必须存在）与 `ArrayVec<_, 4>` 的 `try_into().unwrap()`
    /// （面必须**正好** 4 个顶点）；任一不成立即 panic。
    ///
    /// 选点用 `partial_cmp` 比较 `point - start_position` 这个**向量**本身，不是比较距离；
    /// 比较返回 `None`（出现 NaN）时 `unwrap()` 同样 panic。
    fn corner_positions(&self) -> [Vector; 4] {
        let face = self.face().unwrap();
        let vertices: [_; 4] = face
            .vertices()
            .collect::<ArrayVec<_, 4>>()
            .as_ref()
            .try_into()
            .unwrap();
        let mut corner_positions: [Vector; 4] = vertices.map(|v| v.position);

        // 按偏移向量的偏序取最小者（不是按距离取最近者）
        let start_index = corner_positions
            .iter()
            .copied()
            .map(|point| point - self.start_position)
            .enumerate()
            .min_by(|(_a, a_pos), (_b, b_pos)| (a_pos).partial_cmp(b_pos).unwrap())
            .map(|(i, _pos)| i)
            .unwrap();

        corner_positions.rotate_left(start_index);
        corner_positions
    }

    /// 细分后的基准网格：`steps = 2^power + 1`，按 `x` 外层、`y` 内层产出 `steps × steps` 个点。
    ///
    /// 两条对边（角 0→1、角 3→2）先按 `step_scale = 1/(steps - 1)` 等分，再把同一 `x` 上的两点之间
    /// 等分取 `y`，得到双线性插值点（不含位移量）。`power` 每加 1，点数按平方增长。
    fn subdivided_face(&self) -> impl Iterator<Item = Vector> + 'a {
        let steps = 2usize.pow(self.power as u32) + 1;
        let corner_positions = self.corner_positions();

        let step_scale = 1.0 / (steps as f32 - 1.0);
        let edge_intervals = [
            (corner_positions[1] - corner_positions[0]) * step_scale,
            (corner_positions[2] - corner_positions[3]) * step_scale,
        ];

        (0..steps)
            .flat_map(move |x| (0..steps).map(move |y| (x, y)))
            .map(move |(x, y)| {
                let edge_positions = [
                    corner_positions[0] + edge_intervals[0] * x as f32,
                    corner_positions[3] + edge_intervals[1] * x as f32,
                ];
                let segment_interval = (edge_positions[1] - edge_positions[0]) * step_scale;
                edge_positions[0] + (segment_interval * y as f32)
            })
    }

    /// 基准网格点 + 对应位移量：`zip(displacement_vertices(), subdivided_face())`。
    ///
    /// 两边长度不一致时以**短的一边**为准（`zip` 截断），不报错——位移顶点缺失会让结果静默变少。
    pub fn displaced_vertices(&self) -> impl Iterator<Item = Vector> + 'a {
        self.displacement_vertices()
            .zip(self.subdivided_face())
            .map(move |(displacement, base_pos)| base_pos + displacement.displacement())
    }

    /// 把细分网格三角化：先把全部细分顶点收进 `Vec`，再按 `index(x, y) = y * (steps + 1) + x` 取值，
    /// 每个格子出 2 个三角形（共 6 个顶点）。
    ///
    /// `steps = 2^power`，所以需要恰好 `(steps + 1)^2` 个顶点；少一个就 panic
    /// （`displaced_vertices` 的 `zip` 截断会让这种缺失真的发生），不是少出几个三角形。
    pub fn triangulated_displaced_vertices(&self) -> impl Iterator<Item = Vector> + 'a {
        let vertices: Vec<_> = self.displaced_vertices().collect();
        let steps = 2usize.pow(self.power as u32);

        let index = move |x: usize, y: usize| y * (steps + 1) + x;

        (0..steps)
            .flat_map(move |x| (0..steps).map(move |y| (x, y)))
            .flat_map(move |(x, y)| {
                [
                    vertices[index(x, y)],
                    vertices[index(x + 1, y)],
                    vertices[index(x, y + 1)],
                    vertices[index(x + 1, y)],
                    vertices[index(x + 1, y + 1)],
                    vertices[index(x, y + 1)],
                ]
            })
    }
}

impl<'a> Handle<'a, DisplacementSubNeighbour> {
    /// 该子邻居指向的 displacement（`neighbour_index`）；越界返回 `None`。
    pub fn displacement(&self) -> Option<Handle<'a, DisplacementInfo>> {
        self.bsp.displacement(self.data.neighbour_index as usize)
    }
}


impl<'a> Handle<'a, StaticPropLump> {
    /// 该道具的模型路径：`prop_type` 是 `static_props.dict.name` 的下标（直接下标，越界 panic）。
    ///
    /// `Bsp::validate` 已覆盖 static prop→模型名这条关系。同一个类型还有另一个 impl 块
    /// （`data/mod.rs` 的 `as_prop_placement`），不在本文件里。
    pub fn model(&self) -> &'a str {
        self.bsp.static_props.dict.name[self.prop_type as usize].as_str()
    }
}