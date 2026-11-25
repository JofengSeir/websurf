/**
 * 实体系统的**叶层类型**：零 import，只放不依赖任何其它模块的纯数据结构。
 *
 * 为什么单独成文件：`types.ts` 与 `variant.ts` 原本互为依赖（`EntityLike` 要用
 * `Variant` 做参数，`Variant` 要用 `Vec3` / `Color32` / `EntityRef` 做值），
 * 形成 `types <-> variant` 双向环。把这三个结构搬到零依赖的叶子后，`variant.ts`
 * 的出边只剩 `variant -> primitives` 与 `variant -> runtime`，环被打断。
 *
 * 迁移约定：`types.ts` 仍然 re-export 这三个类型，其它模块的旧导入路径不变。
 */

export type Vec3 = [number, number, number];

export interface Color32 {
  r: number;
  g: number;
  b: number;
  a: number;
}

/** `variant_t` 里 `FIELD_EHANDLE` 值的可携带部分（避免与 Entity 类循环依赖）。 */
export interface EntityRef {
  readonly targetname: string;
  readonly classname: string;
}
