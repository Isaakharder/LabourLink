import { LivePhase } from "./greenhouseLiveTypes";
import { rowScreenRect } from "./rowLayout";

// The area an Employee Block's rows cover, per phase — what the live map
// (GreenhouseLiveCanvas) draws its dashed block outline around. One cluster
// per (block, phase), never one per block overall: a block with sections in
// two phases would otherwise get a box spanning the unrelated rows and
// walkway in between. World feet, un-rotated (the canvas rotates the group).
export interface BlockCluster {
  key: string;
  blockId: string;
  minXFt: number;
  maxXFt: number;
  minYFt: number;
  maxYFt: number;
}

export function computeBlockClusters(phases: LivePhase[]): BlockCluster[] {
  const byKey = new Map<string, BlockCluster>();
  for (const phase of phases) {
    for (const row of phase.rows) {
      if (!row.blockId) continue;
      const { width, height } = rowScreenRect(row);
      const x0 = phase.xFeetFromWest + row.xFt;
      const x1 = x0 + width;
      const y0 = phase.yFeetFromNorth + row.yFt;
      const y1 = y0 + height;
      const key = `${row.blockId}:${phase.id}`;
      const existing = byKey.get(key);
      if (!existing) {
        byKey.set(key, { key, blockId: row.blockId, minXFt: x0, maxXFt: x1, minYFt: y0, maxYFt: y1 });
      } else {
        existing.minXFt = Math.min(existing.minXFt, x0);
        existing.maxXFt = Math.max(existing.maxXFt, x1);
        existing.minYFt = Math.min(existing.minYFt, y0);
        existing.maxYFt = Math.max(existing.maxYFt, y1);
      }
    }
  }
  return Array.from(byKey.values());
}
