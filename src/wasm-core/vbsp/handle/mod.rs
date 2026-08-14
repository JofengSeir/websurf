// vbsp 子模块：保留完整解析语义，允许未使用项
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

/// 表示 bsp 文件中的某个数据结构及其所属的 bsp 文件。
///
/// 必须同时持有数据与 bsp 引用，因为许多数据类型引用了 bsp 中其他结构的数据。
pub struct Handle<'a, T> {
    bsp: &'a Bsp,
    data: &'a T,
}

impl<T: Debug> Debug for Handle<'_, T> {
    fn fmt(&self, f: &mut Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Handle")
            .field("data", self.data)
            .finish_non_exhaustive()
    }
}

impl<T> Clone for Handle<'_, T> {
    fn clone(&self) -> Self {
        Handle { ..*self }
    }
}

impl<'a, T> AsRef<T> for Handle<'a, T> {
    fn as_ref(&self) -> &'a T {
        self.data
    }
}

impl<T> Deref for Handle<'_, T> {
    type Target = T;

    fn deref(&self) -> &Self::Target {
        self.data
    }
}

impl<'a, T> Handle<'a, T> {
    pub fn new(bsp: &'a Bsp, data: &'a T) -> Self {
        Handle { bsp, data }
    }
}

impl<'a> Handle<'a, Model> {
    /// 获取组成该模型的所有面
    pub fn faces(&self) -> impl Iterator<Item = Handle<'a, Face>> {
        let start = self.first_face as usize;
        let end = start + self.face_count as usize;
        let bsp = self.bsp;

        bsp.faces[start..end]
            .iter()
            .map(move |face| Handle::new(bsp, face))
    }

    pub fn textures(&self) -> impl Iterator<Item = Handle<'_, TextureInfo>> {
        self.bsp.textures()
    }
}

impl Handle<'_, Node> {
    /// 获取分割该节点的平面
    pub fn plane(&self) -> Handle<'_, Plane> {
        self.bsp.plane(self.plane_index as _).unwrap()
    }
}

impl<'a> Handle<'a, Leaf> {
    /// 获取从此 leaf 可见的所有其他 leaf
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

    /// 获取此 leaf 中的所有面
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
    pub fn texture_data(&self) -> Handle<'a, TextureData> {
        Handle::new(
            self.bsp,
            &self.bsp.textures_data[self.data.texture_data_index as usize],
        )
    }
    pub fn name(&self) -> &'a str {
        self.texture_data().name()
    }

    /// 获取对该纹理唯一但确定的调试颜色
    pub fn debug_color(&self) -> [u8; 3] {
        self.texture_data().debug_color()
    }

    pub fn u(&self, pos: Vector) -> f32 {
        (self.texture_transforms_u[0] * pos.x
            + self.texture_transforms_u[1] * pos.y
            + self.texture_transforms_u[2] * pos.z
            + self.texture_transforms_u[3])
            / self.texture_data().width as f32
    }

    pub fn v(&self, pos: Vector) -> f32 {
        (self.texture_transforms_v[0] * pos.x
            + self.texture_transforms_v[1] * pos.y
            + self.texture_transforms_v[2] * pos.z
            + self.texture_transforms_v[3])
            / self.texture_data().height as f32
    }

    pub fn uv(&self, pos: Vector) -> [f32; 2] {
        [self.u(pos), self.v(pos)]
    }
}

impl<'a> Handle<'a, TextureData> {
    pub fn name(&self) -> &'a str {
        let start = self.bsp.texture_string_tables[self.name_string_table_id as usize] as usize;
        let part = &self.bsp.texture_string_data[start..];
        if let Some((s, _)) = part.split_once('\0') {
            s
        } else {
            part
        }
    }

    /// 获取对该纹理唯一但确定的调试颜色
    pub fn debug_color(&self) -> [u8; 3] {
        let mut name_hasher = RandomState::with_seeds(0, 0, 0, 0).build_hasher();
        self.name().hash(&mut name_hasher);
        let name_hash = name_hasher.finish().to_be_bytes();
        [name_hash[0], name_hash[1], name_hash[2]]
    }
}



impl<'a> Handle<'a, Face> {
    /// 获取面的纹理
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

    /// 获取组成该面的所有顶点
    pub fn vertices(&self) -> impl Iterator<Item = &'a Vertex> + 'a {
        let bsp = self.bsp;
        self.vertex_indexes()
            .map(move |vert_index| bsp.vertices.get(vert_index as usize).unwrap())
    }

    /// 获取组成该面的所有顶点索引。
    ///
    /// 索引指向 bsp 文件的 `vertices` 字段。
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

    pub fn edge_direction(&self) -> EdgeDirection {
        self.bsp.surface_edges[self.first_edge as usize].direction()
    }

    /// 检查面是否标记为可见
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

    /// 对面进行三角剖分。
    ///
    /// 仅适用于可平凡转换为三角形扇的面。
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

    pub fn displacement(&self) -> Option<Handle<'a, DisplacementInfo>> {
        self.bsp.displacement(self.displacement_info as usize)
    }

    /// 获取面的顶点位置。
    ///
    /// 有 displacement 时计算置换顶点，否则用普通三角剖分。
    pub fn vertex_positions(&self) -> impl Iterator<Item = Vector> + 'a {
        self.displacement()
            .map(|displacement| displacement.triangulated_displaced_vertices())
            .map(Either::Left)
            .unwrap_or_else(|| Either::Right(self.triangulate().flatten()))
    }

    pub fn normal(&self) -> Vector {
        self.bsp.plane(self.plane_num as usize).unwrap().normal
    }
}


impl<'a> Handle<'a, DisplacementInfo> {
    pub fn edge_neighbours(&self) -> impl Iterator<Item = Handle<'a, DisplacementSubNeighbour>> {
        self.data
            .edge_neighbours
            .iter()
            .flat_map(|edge| edge.iter())
            .map(|sub| Handle::new(self.bsp, sub))
    }

    pub fn corner_neighbours(&self) -> impl Iterator<Item = Handle<'a, DisplacementInfo>> {
        self.data
            .corner_neighbours
            .iter()
            .flat_map(|corner| corner.neighbours())
            .filter_map(|id| self.bsp.displacement(id as usize))
    }

    pub fn displacement_vertices(&self) -> impl Iterator<Item = Handle<'a, DisplacementVertex>> {
        (self.displacement_vertex_start..(self.displacement_vertex_start + self.vertex_count()))
            .flat_map(|i| self.bsp.displacement_vertex(i as usize))
    }

    pub fn face(&self) -> Option<Handle<'a, Face>> {
        self.bsp.face(self.map_face as usize)
    }

    /// 获取位移面四个角的位置
    fn corner_positions(&self) -> [Vector; 4] {
        let face = self.face().unwrap();
        let vertices: [_; 4] = face
            .vertices()
            .collect::<ArrayVec<_, 4>>()
            .as_ref()
            .try_into()
            .unwrap();
        let mut corner_positions: [Vector; 4] = vertices.map(|v| v.position);

        // 找最接近 displacement 起始位置的角点
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

    pub fn displaced_vertices(&self) -> impl Iterator<Item = Vector> + 'a {
        self.displacement_vertices()
            .zip(self.subdivided_face())
            .map(move |(displacement, base_pos)| base_pos + displacement.displacement())
    }

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
    pub fn displacement(&self) -> Option<Handle<'a, DisplacementInfo>> {
        self.bsp.displacement(self.data.neighbour_index as usize)
    }
}


impl<'a> Handle<'a, StaticPropLump> {
    pub fn model(&self) -> &'a str {
        self.bsp.static_props.dict.name[self.prop_type as usize].as_str()
    }
}