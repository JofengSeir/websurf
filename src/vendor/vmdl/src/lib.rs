mod compressed_vector;
mod error;
mod handle;
pub mod mdl;
mod shared;
pub mod vtx;
pub mod vvd;

pub use crate::mdl::Mdl;
use crate::mdl::{AnimationDescription, Bone, ModelFlags, PoseParameterDescription, TextureInfo};
pub use crate::vtx::Vtx;
use crate::vvd::Vertex;
pub use crate::vvd::Vvd;
use bytemuck::{pod_read_unaligned, Contiguous, Pod};
use cgmath::{Matrix4, SquareMatrix};
pub use error::*;
pub use handle::Handle;
use itertools::Either;
pub use shared::*;
use std::any::type_name;
use std::fs;
use std::iter::once;
use std::mem::size_of;
use std::path::Path;

pub struct Model {
    #[allow(dead_code)]
    mdl: Mdl,
    vtx: Vtx,
    vvd: Vvd,
}

impl Model {
    pub fn from_parts(mdl: Mdl, vtx: Vtx, vvd: Vvd) -> Self {
        Model { mdl, vtx, vvd }
    }

    /// Load the model from path
    ///
    /// Requires a path to the `.mdl` file and the `.dx90.vtx` and `.vvd` files for the model to be in the same directory.
    pub fn from_path<P: AsRef<Path>>(path: P) -> Result<Self, ModelError> {
        let path = path.as_ref();
        let data = fs::read(path)?;
        let mdl = Mdl::read(&data)?;
        let data = fs::read(path.with_extension("dx90.vtx"))?;
        let vtx = Vtx::read(&data)?;
        let data = fs::read(path.with_extension("vvd"))?;
        let vvd = Vvd::read(&data)?;

        Ok(Model::from_parts(mdl, vtx, vvd))
    }

    pub fn vertices(&self) -> &[Vertex] {
        &self.vvd.vertices
    }

    pub fn tangents(&self) -> &[[f32; 4]] {
        &self.vvd.tangents
    }

    pub fn texture_directories(&self) -> &[String] {
        &self.mdl.texture_paths
    }

    pub fn textures(&self) -> &[TextureInfo] {
        &self.mdl.textures
    }

    pub fn skin_tables(&self) -> impl Iterator<Item = SkinTable<'_>> {
        if self.mdl.header.skin_reference_count > 0 {
            Either::Left(
                self.mdl
                    .skin_table
                    .chunks(self.mdl.header.skin_reference_count as usize)
                    .map(|chunk| SkinTable {
                        table: chunk,
                        textures: &self.mdl.textures,
                    }),
            )
        } else {
            Either::Right(once(SkinTable {
                table: &[],
                textures: &[],
            }))
        }
    }

    pub fn animations(&self) -> impl Iterator<Item = &AnimationDescription> {
        self.mdl.local_animations.iter()
    }

    pub fn meshes(&self) -> impl Iterator<Item = Mesh<'_>> {
        let mdl_meshes = self
            .mdl
            .body_parts
            .iter()
            .flat_map(|part| part.models.iter())
            .flat_map(|model| {
                model
                    .meshes
                    .iter()
                    .map(|mesh| (mesh, model.name.as_str(), model.vertex_offset as usize))
            });

        let vtx_meshes = self
            .vtx
            .body_parts
            .iter()
            .flat_map(|part| part.models.iter())
            .flat_map(|model| model.lods.first())
            .flat_map(|lod| lod.meshes.iter());

        mdl_meshes
            .zip(vtx_meshes)
            .map(|((mdl, model_name, model_vertex_offset), vtx)| Mesh {
                model_vertex_offset,
                model_name,
                vertices: self.vertices(),
                tangents: self.tangents(),
                mdl,
                vtx,
            })
    }

    /// Calculate bounding coordinates of the model
    pub fn bounding_box(&self) -> (Vector, Vector) {
        (
            self.mdl.header.bounding_box[0],
            self.mdl.header.bounding_box[1],
        )
    }

    pub fn name(&self) -> &str {
        self.mdl.name.as_str()
    }

    pub fn bones(&self) -> impl Iterator<Item = &Bone> {
        self.mdl.bones.iter()
    }

    pub fn root_transform(&self) -> Matrix4<f32> {
        if self.mdl.header.flags.contains(ModelFlags::STATIC_PROP) {
            return Matrix4::identity();
        }

        self.bones()
            .next()
            .map(|bone| Matrix4::from(bone.rot))
            .unwrap_or_else(Matrix4::identity)
    }

    pub fn idle_transform(&self) -> Matrix4<f32> {
        if self.mdl.header.flags.contains(ModelFlags::STATIC_PROP) {
            return Matrix4::identity();
        }

        self.mdl
            .local_animations
            .iter()
            .filter_map(|desc| desc.animations.iter().find(|animation| animation.bone == 0))
            .find(|anim| anim.rotation_looks_valid())
            .map(|animation| animation.rotation(0))
            .map(Matrix4::from)
            .unwrap_or_else(Matrix4::identity)
    }

    pub fn surface_prop(&self) -> &str {
        self.mdl.surface_prop.as_str()
    }

    pub fn poses(&self) -> impl Iterator<Item = &PoseParameterDescription> {
        self.mdl.pose_parameters.iter()
    }

    pub fn apply_root_transform(&self, vec: Vector) -> Vector {
        let skin = self.idle_skin_matrices();
        if let Some(m) = skin.first() {
            let p = mat3x4_transform_point(m, [vec.x, vec.y, vec.z]);
            Vector {
                x: p[0],
                y: p[1],
                z: p[2],
            }
        } else {
            vec
        }
    }

    /// Compute row-major 3x4 Source Z-up skinning matrices (`world[b] * pose_to_bone[b]`)
    /// from the first non-delta local animation at frame 0 (falling back to bind pose `bone.pos`
    /// and `bone.quaternion` per bone). Returns empty for `STATIC_PROP` or boneless models.
    pub fn idle_skin_matrices(&self) -> Vec<[[f32; 4]; 3]> {
        if self.mdl.header.flags.contains(ModelFlags::STATIC_PROP) || self.mdl.bones.is_empty() {
            return Vec::new();
        }
        const STUDIO_DELTA: i32 = 0x0004;
        let idle_anim = self
            .mdl
            .local_animations
            .iter()
            .find(|desc| (desc.flags & STUDIO_DELTA) == 0);

        let bone_count = self.mdl.bones.len();
        let mut world = Vec::with_capacity(bone_count);
        let mut skin = Vec::with_capacity(bone_count);

        for (b, bone) in self.mdl.bones.iter().enumerate() {
            let anim_entry = idle_anim.and_then(|desc| {
                desc.animations
                    .iter()
                    .find(|anim| anim.bone as usize == b)
            });
            let quat = anim_entry
                .and_then(|e| e.raw_rotation_quat(0, bone))
                .unwrap_or_else(|| {
                    let q = bone.quaternion;
                    let len = (q.x * q.x + q.y * q.y + q.z * q.z + q.w * q.w).sqrt();
                    if len > 1e-6 {
                        [q.x / len, q.y / len, q.z / len, q.w / len]
                    } else {
                        [0.0, 0.0, 0.0, 1.0]
                    }
                });
            let pos = anim_entry
                .and_then(|e| e.raw_position_vec(0, bone))
                .unwrap_or([bone.pos.x, bone.pos.y, bone.pos.z]);
            let local = mat3x4_from_quat_pos(quat, pos);
            let w = if bone.parent >= 0 && (bone.parent as usize) < b {
                mat3x4_mul(&world[bone.parent as usize], &local)
            } else {
                local
            };
            skin.push(mat3x4_mul(&w, &bone.pose_to_bone.rows()));
            world.push(w);
        }
        skin
    }

    /// Transform a `.vvd` vertex position into Source Z-up model space using precomputed skin matrices.
    pub fn skin_vertex_position(&self, skin: &[[[f32; 4]; 3]], v: &Vertex) -> Vector {
        if skin.is_empty() {
            return v.position;
        }
        let p = [v.position.x, v.position.y, v.position.z];
        let mut acc = [0.0f32; 3];
        let mut total_w = 0.0f32;
        for bw in v.bone_weights.weights() {
            if bw.weight <= 0.0 {
                continue;
            }
            let m = skin.get(bw.bone_id as usize).unwrap_or(&skin[0]);
            let t = mat3x4_transform_point(m, p);
            acc[0] += t[0] * bw.weight;
            acc[1] += t[1] * bw.weight;
            acc[2] += t[2] * bw.weight;
            total_w += bw.weight;
        }
        if total_w > 1e-6 {
            Vector {
                x: acc[0] / total_w,
                y: acc[1] / total_w,
                z: acc[2] / total_w,
            }
        } else {
            let t = mat3x4_transform_point(&skin[0], p);
            Vector {
                x: t[0],
                y: t[1],
                z: t[2],
            }
        }
    }

    /// Transform a `.vvd` vertex normal into Source Z-up model space using precomputed skin matrices.
    pub fn skin_vertex_normal(&self, skin: &[[[f32; 4]; 3]], v: &Vertex) -> Vector {
        if skin.is_empty() {
            return v.normal;
        }
        let n = [v.normal.x, v.normal.y, v.normal.z];
        let mut acc = [0.0f32; 3];
        let mut any = false;
        for bw in v.bone_weights.weights() {
            if bw.weight <= 0.0 {
                continue;
            }
            let m = skin.get(bw.bone_id as usize).unwrap_or(&skin[0]);
            let t = mat3x4_transform_vector(m, n);
            acc[0] += t[0] * bw.weight;
            acc[1] += t[1] * bw.weight;
            acc[2] += t[2] * bw.weight;
            any = true;
        }
        let raw = if any {
            acc
        } else {
            mat3x4_transform_vector(&skin[0], n)
        };
        let len = (raw[0] * raw[0] + raw[1] * raw[1] + raw[2] * raw[2]).sqrt();
        if len > 1e-6 {
            Vector {
                x: raw[0] / len,
                y: raw[1] / len,
                z: raw[2] / len,
            }
        } else {
            v.normal
        }
    }
}

pub fn mat3x4_from_quat_pos(q: [f32; 4], t: [f32; 3]) -> [[f32; 4]; 3] {
    let [x, y, z, w] = q;
    let xx = x * x;
    let yy = y * y;
    let zz = z * z;
    let xy = x * y;
    let xz = x * z;
    let yz = y * z;
    let wx = w * x;
    let wy = w * y;
    let wz = w * z;
    [
        [1.0 - 2.0 * (yy + zz), 2.0 * (xy - wz), 2.0 * (xz + wy), t[0]],
        [2.0 * (xy + wz), 1.0 - 2.0 * (xx + zz), 2.0 * (yz - wx), t[1]],
        [2.0 * (xz - wy), 2.0 * (yz + wx), 1.0 - 2.0 * (xx + yy), t[2]],
    ]
}

pub fn mat3x4_mul(a: &[[f32; 4]; 3], b: &[[f32; 4]; 3]) -> [[f32; 4]; 3] {
    let mut out = [[0.0f32; 4]; 3];
    for r in 0..3 {
        for c in 0..3 {
            out[r][c] = a[r][0] * b[0][c] + a[r][1] * b[1][c] + a[r][2] * b[2][c];
        }
        out[r][3] = a[r][0] * b[0][3] + a[r][1] * b[1][3] + a[r][2] * b[2][3] + a[r][3];
    }
    out
}

pub fn mat3x4_transform_point(m: &[[f32; 4]; 3], p: [f32; 3]) -> [f32; 3] {
    [
        m[0][0] * p[0] + m[0][1] * p[1] + m[0][2] * p[2] + m[0][3],
        m[1][0] * p[0] + m[1][1] * p[1] + m[1][2] * p[2] + m[1][3],
        m[2][0] * p[0] + m[2][1] * p[1] + m[2][2] * p[2] + m[2][3],
    ]
}

pub fn mat3x4_transform_vector(m: &[[f32; 4]; 3], v: [f32; 3]) -> [f32; 3] {
    [
        m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2],
        m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2],
        m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2],
    ]
}

pub struct SkinTable<'a> {
    textures: &'a [TextureInfo],
    table: &'a [u16],
}

impl<'a> SkinTable<'a> {
    pub fn texture(&self, index: i32) -> Option<&'a str> {
        self.texture_info(index).map(|info| info.name.as_str())
    }

    pub fn texture_index(&self, index: i32) -> Option<usize> {
        let texture_index = self.table.get(index as usize)?;
        Some(*texture_index as usize)
    }
    pub fn texture_info(&self, index: i32) -> Option<&'a TextureInfo> {
        let texture_index = self.table.get(index as usize)?;
        self.textures.get(*texture_index as usize)
    }
}

pub struct Mesh<'a> {
    pub model_name: &'a str,
    model_vertex_offset: usize,
    vertices: &'a [Vertex],
    tangents: &'a [[f32; 4]],
    mdl: &'a mdl::Mesh,
    vtx: &'a vtx::Mesh,
}

impl<'a> Mesh<'a> {
    /// Vertex indices into the model's vertex list
    pub fn vertex_strip_indices(&self) -> impl Iterator<Item = impl Iterator<Item = usize> + 'a> {
        let mdl_offset = self.mdl.vertex_offset as usize + self.model_vertex_offset;
        self.vtx.strip_groups.iter().flat_map(move |strip_group| {
            let group_indices = &strip_group.indices;
            let vertices = &strip_group.vertices;
            strip_group.strips.iter().map(move |strip| {
                strip
                    .indices()
                    .map(move |index| group_indices[index] as usize)
                    .map(move |index| vertices[index].original_mesh_vertex_id as usize + mdl_offset)
            })
        })
    }

    pub fn material_index(&self) -> i32 {
        self.mdl.material
    }

    pub fn vertices(&self) -> impl Iterator<Item = &'a Vertex> + 'a {
        self.vertex_strip_indices()
            .flat_map(|strip| strip.map(|index| &self.vertices[index]))
    }

    pub fn tangents(&self) -> impl Iterator<Item = [f32; 4]> + '_ {
        self.vertex_strip_indices()
            .flat_map(|strip| strip.map(|index| self.tangents[index]))
    }
}

fn index_range(index: i32, count: i32, size: usize) -> impl Iterator<Item = usize> {
    (0..count as usize)
        .map(move |i| i * size)
        .map(move |i| index as usize + i)
}

fn read_relative_iter<'a, T: ReadRelative, I: 'a + Iterator<Item = usize>>(
    data: &'a [u8],
    indexes: I,
) -> impl Iterator<Item = Result<T, ModelError>> + 'a {
    indexes.map(|index| {
        let data = data.get(index..).ok_or_else(|| ModelError::OutOfBounds {
            data: type_name::<T>(),
            offset: index,
        })?;
        let header = <T::Header as Readable>::read(data)?;
        T::read(data, header)
    })
}

fn read_relative<T: ReadRelative, I: Iterator<Item = usize>>(
    data: &[u8],
    indexes: I,
) -> Result<Vec<T>, ModelError> {
    read_relative_iter(data, indexes).collect()
}

fn read_single<T: ReadRelative, I: TryInto<usize>>(data: &[u8], index: I) -> Result<T, ModelError> {
    let index = index.try_into().map_err(|_| ModelError::OutOfBounds {
        data: type_name::<T>(),
        offset: usize::MAX_VALUE,
    })?;
    let data = data.get(index..).ok_or_else(|| ModelError::OutOfBounds {
        data: type_name::<T>(),
        offset: index,
    })?;
    let header = <T::Header as Readable>::read(data)?;
    T::read(data, header)
}

trait Readable: Sized {
    fn read(data: &[u8]) -> Result<Self, ModelError>;
}

impl<T: Pod> Readable for T {
    fn read(data: &[u8]) -> Result<Self, ModelError> {
        let data = data
            .get(0..size_of::<Self>())
            .ok_or(ModelError::Eof(size_of::<Self>()))?;
        Ok(pod_read_unaligned(data))
    }
}

trait ReadRelative: Sized {
    type Header: Readable;

    fn read(data: &[u8], header: Self::Header) -> Result<Self, ModelError>;
}

trait ReadableRelative: Readable {}

impl ReadableRelative for u8 {}
impl ReadableRelative for u16 {}
impl ReadableRelative for u32 {}
impl ReadableRelative for i8 {}
impl ReadableRelative for i16 {}
impl ReadableRelative for i32 {}
impl ReadableRelative for f32 {}
impl<T: ReadableRelative + Pod> ReadableRelative for [T; 1] {}
impl<T: ReadableRelative + Pod> ReadableRelative for [T; 2] {}
impl<T: ReadableRelative + Pod> ReadableRelative for [T; 3] {}
impl<T: ReadableRelative + Pod> ReadableRelative for [T; 4] {}

impl<T: ReadableRelative> ReadRelative for T {
    type Header = T;

    fn read(_data: &[u8], header: Self::Header) -> Result<Self, ModelError> {
        Ok(header)
    }
}

impl ReadRelative for String {
    type Header = ();

    fn read(data: &[u8], _header: Self::Header) -> Result<Self, ModelError> {
        let bytes = data.iter().copied().take_while(|byte| *byte != 0).collect();
        String::from_utf8(bytes).map_err(ModelError::from)
    }
}


impl Model {
    /// 把 `.vhv` 的逐顶点光照从 **strip group 顶点序** 重排到 **模型顶点序**。
    ///
    /// Source 写 `.vhv` 是"一个 strip group 一个块"，块内是 `pVertex(nVertex)` 的局部下标序
    /// （`utils/vrad/vradstaticprops.cpp`：`m_VertexColors[nVertex] = colorVerts[mesh->vertexoffset + pVertex(nVertex)->origMeshVertID]`），
    /// 而模型顶点数组是按 `origMeshVertID` 排的——两者不同序，照数组下标硬对应会把光照贴到别的
    /// 顶点上（`rock04_epic` 的 strip group 前几个 `origMeshVertID` 是 `389,392,391,1080,…`）。
    ///
    /// `colors` 必须正好覆盖全部 strip group 的顶点（按 mesh → strip group 顺序拼接）；任何一处
    /// 对不上就返回 `None`，由调用方退回 leaf ambient cube（不产出错位数据）。
    /// strip group 顶点总数：即 `remap_strip_group_colors` 期望的 `colors` 长度
    /// （`.vhv` 按「mesh → strip group」顺序拼接块，与该总数一一对应）。
    pub fn strip_vertex_total(&self) -> usize {
        self.meshes()
            .flat_map(|mesh| mesh.vtx.strip_groups.iter())
            .map(|sg| sg.vertices.len())
            .sum()
    }

    pub fn remap_strip_group_colors(&self, colors: &[[f32; 3]]) -> Option<Vec<[f32; 3]>> {
        let mut out = vec![[0.0f32; 3]; self.vertices().len()];
        let mut src = 0usize;
        for mesh in self.meshes() {
            let base = mesh.mdl.vertex_offset as usize + mesh.model_vertex_offset;
            for strip_group in mesh.vtx.strip_groups.iter() {
                let n = strip_group.vertices.len();
                let chunk = colors.get(src..src + n)?;
                for (i, v) in strip_group.vertices.iter().enumerate() {
                    *out.get_mut(base + v.original_mesh_vertex_id as usize)? = chunk[i];
                }
                src += n;
            }
        }
        (src == colors.len()).then_some(out)
    }
}
