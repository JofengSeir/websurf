use crate::vbsp::*;
use binrw::io::Cursor;
use binrw::BinReaderExt;
use std::borrow::Cow;

pub struct BspFile<'a> {
    data: &'a [u8],
    directories: Directories,
    header: Header,
}

impl<'a> BspFile<'a> {
    pub fn new(data: &'a [u8]) -> BspResult<Self> {
        const EXPECTED_HEADER: Header = Header {
            v: b'V',
            b: b'B',
            s: b'S',
            p: b'P',
        };
        // Source 1 家族版本范围（CSS/HL2 v19-v20、CS:GO v20-v21、L4D2/Portal2 v21+）。
        // 实证（2026-08-14）：v20 与 v21 的 lump version 分布一致（NODES v0 / LEAFS v1 /
        // FACES v1 / 其余 v0），NODES/LEAFS/FACES 记录大小相同（32/32/56B）——
        // v21 地图（如 ze_cursed_bear_tales）与 v20 共用同一布局，仅需放宽版本检查。
        // 注：v19 早期 CSS 图的 FACES 可能是 v0（28B），需 lump version 分派（未实现）。
        const VERSION_MIN: u32 = 19;
        const VERSION_MAX: u32 = 29;

        let mut cursor = Cursor::new(data);
        let header: Header = cursor.read_le()?;
        let version: u32 = cursor.read_le()?;

        if header != EXPECTED_HEADER || !(VERSION_MIN..=VERSION_MAX).contains(&version) {
            return Err(BspError::UnexpectedHeader(header));
        }

        let directories = cursor.read_le()?;

        Ok(BspFile {
            data,
            directories,
            header,
        })
    }

    pub fn header(&self) -> &Header {
        &self.header
    }

    pub fn lump_reader(&self, lump: LumpType) -> BspResult<LumpReader<Cursor<Cow<'_, [u8]>>>> {
        let lump_entry = &self.directories[lump];
        let data = self.get_lump(lump)?;
        Ok(LumpReader::new(data, lump, lump_entry.version))
    }

    pub fn get_lump(&self, lump: LumpType) -> BspResult<Cow<'_, [u8]>> {
        let lump = &self.directories[lump];
        let raw_data = self
            .data
            .get(lump.offset as usize..lump.offset as usize + lump.length as usize)
            .ok_or(BspError::LumpOutOfBounds(*lump))?;

        Ok(match lump.ident {
            0 => Cow::Borrowed(raw_data),
            _ => {
                let data = lzma_decompress_with_header(raw_data, lump.ident as usize)?;
                Cow::Owned(data)
            }
        })
    }
}

#[allow(dead_code)]
#[repr(C)]
#[derive(Clone, Copy, Debug, Eq, PartialEq, Hash)]
pub enum LumpType {
    Entities,
    Planes,
    TextureData,
    Vertices,
    Visibility,
    Nodes,
    TextureInfo,
    Faces,
    Lighting,
    Occlusion,
    Leaves,
    FaceIds,
    Edges,
    SurfaceEdges,
    Models,
    WorldLights,
    LeafFaces,
    LeafBrushes,
    Brushes,
    BrushSides,
    Areas,
    AreaPortals,
    Unused0,
    Unused1,
    Unused2,
    Unused3,
    DisplacementInfo,
    OriginalFaces,
    PhysDisplacement,
    PhysCollide,
    VertNormals,
    VertNormalIndices,
    DisplacementLightMapAlphas,
    DisplacementVertices,
    DisplacementLightMapSamplePositions,
    GameLump,
    LeafWaterData,
    Primitives,
    PrimVertices,
    PrimIndices,
    PakFile,
    ClipPortalVertices,
    CubeMaps,
    TextureDataStringData,
    TextureDataStringTable,
    Overlays,
    LeafMinimumDistanceToWater,
    FaceMacroTextureInfo,
    DisplacementTris,
    PhysicsCollideSurface,
    WaterOverlays,
    LeafAmbientIndexHdr,
    LeafAmbientIndex,
    LightingHdr,
    WorldLightsHdr,
    LeafAmbientLightingHdr,
    LeafAmbientLighting,
    XZipPakFile,
    FacesHdr,
    MapFlags,
    OverlayFades,
    OverlaySystemLevels,
    PhysLevel,
    DisplacementMultiBlend,
}

static_assertions::const_assert_eq!(LumpType::DisplacementMultiBlend as usize, 63);
