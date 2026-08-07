//! PhysWorld — 权威/预测共用的 Rust 物理世界（wasm-bindgen 绑定层）。
//!
//! 组装：World（brush/tri 碰撞 + 双空间索引）+ Player（全套移动语义）+ TeleportManager。
//! 导出 9 个 API：build_world / tick / predict / respawn / teleport_to / set_death_y /
//! set_params / set_hull / set_noclip。
//!
//! 线程模型：Worker-A（权威）与 Worker-B（预测）各持一个本实例（同一 wasm 模块，
//! 各自线性内存）；tick/predict 输入输出经标量传值（每帧 ~8 个 f64），无 SAB 直写。

pub mod player;
pub mod teleport;
pub mod world;

use player::{create_player, player_tick, PhysParams, Player};
use teleport::{check_death, TeleportManager};
use world::{Brush, LadderVolume, TriMesh, World};

use wasm_bindgen::prelude::*;

/// 与 lib.rs 共享的 brush 输出结构（collect_phys_brushes 返回）。
#[derive(Clone, Debug)]
pub struct PhysBrush {
    pub planes: Vec<PhysPlane>,
    pub min: [f32; 3],
    pub max: [f32; 3],
    pub is_ladder: bool,
    pub is_solid: bool,
}

#[derive(Clone, Copy, Debug)]
pub struct PhysPlane {
    pub normal: [f32; 3],
    pub dist: f32,
}

/// 物理世界（wasm-bindgen 导出类）。
#[wasm_bindgen]
pub struct PhysWorld {
    world: World,
    player: Player,
    params: PhysParams,
    teleport: TeleportManager,
    /// 初始出生点（respawn / 死亡重生）。
    spawn: [f64; 3],
    /// 全部出生点列表（[x,y,z,yaw]，spawn 下拉切换用）。
    spawn_points: Vec<[f64; 4]>,
    /// 死亡 Y 阈值（主线程从场景包围盒算好回传）。
    death_y: f64,
    /// noclip 自由视角模式（JS 侧维护位置，本实例仅标记）。
    noclip: bool,
    /// 构建期是否已加载世界。
    ready: bool,
}

#[wasm_bindgen]
impl PhysWorld {
    /// 构建物理世界：从 BSP 字节直接构建 brush 碰撞 + 模型三角形碰撞 + 传送点。
    ///
    /// 零 JSON 中转：brush 由 lib.rs 的 collect_phys_brushes 从 Bsp 内存直建；
    /// tri/teleport 复用导出 JSON（构建期一次，非热路径，可接受）。
    #[wasm_bindgen(constructor)]
    pub fn new() -> PhysWorld {
        PhysWorld {
            world: World::new(),
            player: create_player([0.0, 100.0, 0.0], &PhysParams::default()),
            params: PhysParams::default(),
            teleport: TeleportManager::default(),
            spawn: [0.0, 100.0, 0.0],
            spawn_points: Vec::new(),
            death_y: -100_000.0,
            noclip: false,
            ready: false,
        }
    }

    /// 加载世界数据（brush JSON + tri JSON + teleport JSON + spawn + yaw）。
    /// 与 BspProcessor 的生命周期解耦：主线程在 export_glb* 之前调用本方法，
    /// 传入各导出 JSON；brush 数据来自 lib.rs collect（已 Y-up、法线朝外）。
    pub fn build_world(
        &mut self,
        brush_json: &str,
        tri_json: &str,
        teleport_json: &str,
        spawn_x: f64,
        spawn_y: f64,
        spawn_z: f64,
        spawn_yaw: f64,
    ) -> Result<(), JsValue> {
        // 1. brush → World.solids/ladders
        let brushes = parse_brushes(brush_json)?;
        for b in brushes {
            let planes: Vec<world::Plane> = b
                .planes
                .iter()
                .map(|p| world::Plane {
                    normal: [p.normal[0] as f64, p.normal[1] as f64, p.normal[2] as f64],
                    dist: p.dist as f64,
                })
                .collect();
            let min = [b.min[0] as f64, b.min[1] as f64, b.min[2] as f64];
            let max = [b.max[0] as f64, b.max[1] as f64, b.max[2] as f64];
            if b.is_ladder {
                let facing = compute_ladder_facing(&planes);
                self.world.ladders.push(LadderVolume {
                    planes,
                    min,
                    max,
                    facing,
                });
            } else if b.is_solid {
                self.world.solids.push(Brush { planes, min, max });
            }
        }

        // 2. tri → World.tri_meshes（紧凑数组 [x,y,z]）
        let tri_meshes = parse_tri_meshes(tri_json)?;
        self.world.tri_meshes = tri_meshes;

        // 3. 空间索引
        self.world.build_index();

        // 4. teleport
        self.teleport = TeleportManager::from_json(teleport_json)
            .map_err(|e| JsValue::from_str(&format!("teleport: {e}")))?;

        // 5. 出生点 + 玩家
        self.spawn = [spawn_x, spawn_y, spawn_z];
        self.player = create_player(self.spawn, &self.params);
        self.player.yaw = spawn_yaw;
        self.player.prev_origin = self.spawn;
        self.ready = true;
        Ok(())
    }

    /// 权威物理 tick（Worker-A）：一个固定步长，返回状态对象。
    pub fn tick(
        &mut self,
        dt: f64,
        keys_mask: u32,
        dx: f64,
        dy: f64,
    ) -> Result<JsValue, JsValue> {
        if !self.ready {
            return Ok(self.state_js());
        }
        // 输入：键位掩码 → InputState；鼠标增量 → yaw/pitch
        apply_input(&mut self.player, keys_mask);
        self.player.yaw -= dx * (self.params.sensitivity * player::M_YAW);
        self.player.pitch -= dy * (self.params.sensitivity * player::M_YAW);
        self.player.pitch = self
            .player
            .pitch
            .max(-player::PITCH_CLAMP)
            .min(player::PITCH_CLAMP);

        if self.noclip {
            noclip_step(&mut self.player, dt, &self.params);
        } else {
            // 传送检测（权威才检测；predict 禁用；落地稳定 ≥3 帧才判定位于传送平面）
            if let Some(dest) = self.teleport.check(
                &self.player.origin,
                self.player.ground_ticks_since_landing,
                self.params.teleport_gate_ticks,
                dt,
                false,
            ) {
                self.apply_teleport(&dest.origin, dest.yaw);
                self.teleport.on_teleported();
                self.teleport.reset_cooldown();
            }
            // 死亡判定
            if let Some(sp) = check_death(&self.player.origin, self.death_y, &self.spawn) {
                self.player.respawn(&sp);
                self.teleport.reset_cooldown();
            }
            // reset 键 → respawn
            if self.player.input.reset {
                self.player.input.reset = false;
                self.player.respawn(&self.spawn);
            }
            player_tick(&mut self.world, &mut self.player, &self.params, dt);
        }
        Ok(self.state_js())
    }

    /// 预测微步（Worker-B）：2 子步轻量预测，禁用传送/死亡副作用。
    pub fn predict(
        &mut self,
        dt: f64,
        keys_mask: u32,
        dx: f64,
        dy: f64,
    ) -> Result<JsValue, JsValue> {
        if !self.ready || self.noclip {
            return Ok(self.state_js());
        }
        apply_input(&mut self.player, keys_mask);
        self.player.yaw -= dx * (self.params.sensitivity * player::M_YAW);
        self.player.pitch -= dy * (self.params.sensitivity * player::M_YAW);
        self.player.pitch = self
            .player
            .pitch
            .max(-player::PITCH_CLAMP)
            .min(player::PITCH_CLAMP);
        player_tick(&mut self.world, &mut self.player, &self.params, dt);
        Ok(self.state_js())
    }

    /// 重生到初始出生点。
    pub fn respawn(&mut self) {
        self.player.respawn(&self.spawn);
        self.teleport.reset_cooldown();
    }

    /// 传送到指定坐标（度 yaw）。
    pub fn teleport_to(&mut self, x: f64, y: f64, z: f64, yaw: f64) {
        self.apply_teleport(&[x, y, z], yaw);
    }

    /// 设置全部出生点列表（spawn 下拉切换用）。JSON：`[[x,y,z,yaw], ...]`。
    pub fn set_spawn_points(&mut self, json: &str) -> Result<(), JsValue> {
        let list: Vec<[f64; 4]> =
            serde_json::from_str(json).map_err(|e| to_js_err(e, "set_spawn_points"))?;
        self.spawn_points = list;
        Ok(())
    }

    /// 传送到指定出生点索引（spawn 下拉）。索引无效时忽略。
    pub fn teleport_to_spawn(&mut self, idx: usize) {
        if let Some(sp) = self.spawn_points.get(idx) {
            self.apply_teleport(&[sp[0], sp[1], sp[2]], sp[3]);
        }
    }

    /// 基线同步（Worker-B 预测用）：把权威状态写回预测实例，再从此继续 2 子步预测。
    /// 时序图 §3.4：预测基线 = acquire 读权威 S。不重置速度/着地（预测需延续运动）。
    pub fn set_state(
        &mut self,
        pos_x: f64,
        pos_y: f64,
        pos_z: f64,
        yaw: f64,
        pitch: f64,
        vel_x: f64,
        vel_y: f64,
        vel_z: f64,
        on_ground: bool,
    ) {
        self.player.origin = [pos_x, pos_y, pos_z];
        self.player.yaw = yaw;
        self.player.pitch = pitch;
        self.player.velocity = [vel_x, vel_y, vel_z];
        self.player.on_ground = on_ground;
        self.player.prev_origin = self.player.origin;
    }

    /// 设置死亡 Y 阈值。
    pub fn set_death_y(&mut self, y: f64) {
        self.death_y = y;
    }

    /// 设置物理参数（面板：gravity/accelerate/friction/stopSpeed/jumpHeight/airAccelerate/
    /// runSpeed/walkSpeed/crouchSpeed/autobhop/bhopSpeedClamp/noPrestrafe/sensitivity/yawBindSpeed）。
    pub fn set_params(&mut self, json: &str) -> Result<(), JsValue> {
        #[derive(serde::Deserialize)]
        struct Patch {
            gravity: Option<f64>,
            accelerate: Option<f64>,
            friction: Option<f64>,
            stop_speed: Option<f64>,
            jump_height: Option<f64>,
            air_accelerate: Option<f64>,
            run_speed: Option<f64>,
            walk_speed: Option<f64>,
            crouch_speed: Option<f64>,
            autobhop: Option<bool>,
            bhop_speed_clamp: Option<bool>,
            no_prestrafe: Option<bool>,
            sensitivity: Option<f64>,
            yaw_bind_speed: Option<f64>,
            noclip_speed: Option<f64>,
            teleport_gate_ticks: Option<u32>,
        }
        let p: Patch = serde_json::from_str(json).map_err(|e| to_js_err(e, "set_params"))?;
        if let Some(v) = p.gravity {
            self.params.gravity = v;
        }
        if let Some(v) = p.accelerate {
            self.params.accelerate = v;
        }
        if let Some(v) = p.friction {
            self.params.friction = v;
        }
        if let Some(v) = p.stop_speed {
            self.params.stop_speed = v;
        }
        if let Some(v) = p.jump_height {
            self.params.jump_height = v;
        }
        if let Some(v) = p.air_accelerate {
            self.params.air_accelerate = v;
        }
        if let Some(v) = p.run_speed {
            self.params.run_speed = v;
        }
        if let Some(v) = p.walk_speed {
            self.params.walk_speed = v;
        }
        if let Some(v) = p.crouch_speed {
            self.params.crouch_speed = v;
        }
        if let Some(v) = p.autobhop {
            self.params.autobhop = v;
        }
        if let Some(v) = p.bhop_speed_clamp {
            self.params.bhop_speed_clamp = v;
        }
        if let Some(v) = p.no_prestrafe {
            self.params.no_prestrafe = v;
        }
        if let Some(v) = p.sensitivity {
            self.params.sensitivity = v;
        }
        if let Some(v) = p.yaw_bind_speed {
            self.params.yaw_bind_speed = v;
        }
        if let Some(v) = p.noclip_speed {
            self.params.noclip_speed = v;
        }
        if let Some(v) = p.teleport_gate_ticks {
            self.params.teleport_gate_ticks = v;
        }
        Ok(())
    }

    /// 设置碰撞箱体型（面板）。
    pub fn set_hull(&mut self, half_width: f64, stand_height: f64, duck_height: f64) {
        self.params.hull_half_width = half_width;
        self.params.hull_stand_height = stand_height;
        self.params.hull_duck_height = duck_height;
        player::apply_hull(&mut self.player, half_width, stand_height, duck_height);
    }

    /// 设置/退出 noclip 自由视角。
    pub fn set_noclip(&mut self, enabled: bool) {
        self.noclip = enabled;
    }

    /// 当前玩家状态（pos/yaw/pitch/vel/onGround/eyeHeight/timeMs）→ JS 对象。
    pub fn state(&self) -> JsValue {
        self.state_js()
    }
}

impl PhysWorld {
    fn state_js(&self) -> JsValue {
        let p = &self.player;
        let obj = js_sys::Object::new();
        set_f64(&obj, "posX", p.origin[0]);
        set_f64(&obj, "posY", p.origin[1]);
        set_f64(&obj, "posZ", p.origin[2]);
        set_f64(&obj, "yaw", p.yaw);
        set_f64(&obj, "pitch", p.pitch);
        set_f64(&obj, "velX", p.velocity[0]);
        set_f64(&obj, "velY", p.velocity[1]);
        set_f64(&obj, "velZ", p.velocity[2]);
        set_bool(&obj, "onGround", p.on_ground);
        set_f64(&obj, "eyeHeight", p.eye_height());
        obj.into()
    }

    fn apply_teleport(&mut self, origin: &[f64; 3], yaw: f64) {
        self.player.origin = *origin;
        self.player.velocity = [0.0, 0.0, 0.0];
        self.player.on_ground = false;
        self.player.yaw = yaw;
        self.player.prev_origin = *origin;
        self.teleport.reset_cooldown();
    }
}

// ---------------------------------------------------------------------------
// 辅助
// ---------------------------------------------------------------------------

fn to_js_err<E: std::fmt::Debug>(e: E, ctx: &str) -> JsValue {
    JsValue::from_str(&format!("{}: {:?}", ctx, e))
}

fn set_f64(obj: &js_sys::Object, key: &str, v: f64) {
    let _ = js_sys::Reflect::set(obj, &JsValue::from_str(key), &JsValue::from_f64(v));
}

fn set_bool(obj: &js_sys::Object, key: &str, v: bool) {
    let _ = js_sys::Reflect::set(obj, &JsValue::from_str(key), &JsValue::from_bool(v));
}

/// 键位掩码 → InputState（与 TS KEY_MASK 一致）。
fn apply_input(p: &mut Player, mask: u32) {
    p.input.forward = mask & 0x01 != 0;
    p.input.back = mask & 0x02 != 0;
    p.input.left = mask & 0x04 != 0;
    p.input.right = mask & 0x08 != 0;
    p.input.jump = mask & 0x10 != 0;
    p.input.duck = mask & 0x20 != 0;
    p.input.walk = mask & 0x40 != 0;
    p.input.reset = mask & 0x80 != 0;
}

/// noclip 自由视角单步（调试/观赏用；JS 侧也可实现，此处提供 Rust 版保持单一物理源）。
fn noclip_step(p: &mut Player, dt: f64, params: &PhysParams) {
    let fmove = (if p.input.forward { 1.0 } else { 0.0 }) - (if p.input.back { 1.0 } else { 0.0 });
    let smove = (if p.input.right { 1.0 } else { 0.0 }) - (if p.input.left { 1.0 } else { 0.0 });
    if fmove == 0.0 && smove == 0.0 {
        return;
    }
    // noclip_speed 基准；sprint（Shift）再 ×4 加速
    let speed = params.noclip_speed * if p.input.walk { 4.0 } else { 1.0 } * dt;
    let yaw_rad = p.yaw * (std::f64::consts::PI / 180.0);
    let pitch_rad = p.pitch * (std::f64::consts::PI / 180.0);
    let cp = pitch_rad.cos();
    let fwd = [-yaw_rad.sin() * cp, pitch_rad.sin(), -yaw_rad.cos() * cp];
    let right = [yaw_rad.cos(), 0.0, -yaw_rad.sin()];
    p.origin[0] += (fwd[0] * fmove + right[0] * smove) * speed;
    p.origin[1] += fwd[1] * fmove * speed;
    p.origin[2] += (fwd[2] * fmove + right[2] * smove) * speed;
    p.prev_origin = p.origin;
}

/// 解析 brush JSON（WasmBrush[] 紧凑格式，Y-up、法线朝外）。
fn parse_brushes(json: &str) -> Result<Vec<PhysBrush>, JsValue> {
    #[derive(serde::Deserialize)]
    struct WasmBrushPlane {
        normal: [f32; 3],
        dist: f32,
    }
    #[derive(serde::Deserialize)]
    struct WasmBrush {
        planes: Vec<WasmBrushPlane>,
        min: [f32; 3],
        max: [f32; 3],
        is_ladder: bool,
        is_solid: bool,
    }
    let data: Vec<WasmBrush> =
        serde_json::from_str(json).map_err(|e| to_js_err(e, "brush JSON 解析"))?;
    Ok(data
        .into_iter()
        .map(|b| PhysBrush {
            planes: b
                .planes
                .into_iter()
                .map(|p| PhysPlane {
                    normal: p.normal,
                    dist: p.dist,
                })
                .collect(),
            min: b.min,
            max: b.max,
            is_ladder: b.is_ladder,
            is_solid: b.is_solid,
        })
        .collect())
}

/// 解析 tri JSON（TriMesh[]，紧凑 vertices/indices/min/max）。
fn parse_tri_meshes(json: &str) -> Result<Vec<TriMesh>, JsValue> {
    if json.trim().is_empty() {
        return Ok(Vec::new());
    }
    #[derive(serde::Deserialize)]
    struct WasmTriMesh {
        vertices: Vec<[f64; 3]>,
        indices: Vec<[u32; 3]>,
        min: [f64; 3],
        max: [f64; 3],
    }
    let data: Vec<WasmTriMesh> =
        serde_json::from_str(json).map_err(|e| to_js_err(e, "tri JSON 解析"))?;
    Ok(data
        .into_iter()
        .map(|m| TriMesh {
            vertices: m.vertices,
            indices: m.indices,
            min: m.min,
            max: m.max,
        })
        .collect())
}

/// 计算梯子 brush 的 facing 方向（水平、指向墙外；与原 collider-adapter 一致）。
fn compute_ladder_facing(planes: &[world::Plane]) -> [f64; 3] {
    if planes.is_empty() {
        return [0.0, 0.0, 1.0];
    }
    let mut best = &planes[0];
    let mut best_horiz = -1.0f64;
    for p in planes {
        let horiz = (p.normal[0] * p.normal[0] + p.normal[2] * p.normal[2]).sqrt();
        if horiz > best_horiz {
            best_horiz = horiz;
            best = p;
        }
    }
    let mut fx = best.normal[0];
    let mut fz = best.normal[2];
    let len = (fx * fx + fz * fz).sqrt();
    if len > 1e-6 {
        fx /= len;
        fz /= len;
    } else {
        fx = 0.0;
        fz = 1.0;
    }
    [fx, 0.0, fz]
}
