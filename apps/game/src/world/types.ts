/**
 * 世界类型（最小化版）— 仅保留主线程渲染需要的 PVS 类型。
 */

export interface WasmPvsNode {
  normal: [number, number, number];
  dist: number;
  children: [number, number];
}

export interface WasmPvsLeaf {
  cluster: number;
  mins: [number, number, number];
  maxs: [number, number, number];
  isSolid: boolean;
}

export interface WasmPvsData {
  rootNode: number;
  nodes: WasmPvsNode[];
  leaves: WasmPvsLeaf[];
  faceClusters: number[];
  pvsBitsBase64: string;
  clusterCount: number;
  bytesPerRow: number;
}

export interface Vec3Like {
  x: number;
  y: number;
  z: number;
}

export type Vec3 = Vec3Like;
