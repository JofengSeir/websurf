use super::Handle;
use crate::vbsp::data::*;
use itertools::Either;

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
