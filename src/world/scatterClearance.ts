import { PATH, PATH_W, SPOTS, STAIR } from './layout'
import { stairProfile } from './stairProfile'

export function lineDistance(x: number, z: number, line: ReadonlyArray<readonly [number, number]>) {
  let distance = Infinity
  for (let i = 1; i < line.length; i++) {
    const [ax, az] = line[i - 1], [bx, bz] = line[i]
    const dx = bx - ax, dz = bz - az
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz || 1)))
    distance = Math.min(distance, Math.hypot(x - ax - t * dx, z - az - t * dz))
  }
  return distance
}

/** Reserve the whole object radius, including the connector to the stair landing. */
export function scatterClear(x: number, z: number, radius = 0.7) {
  const { foot, edge } = stairProfile().join
  return !SPOTS.some(s => x > s.x0 - radius && x < s.x1 + radius && z > s.z0 - radius && z < s.z1 + radius)
    && lineDistance(x, z, [...PATH, [foot.x, foot.z], [edge.x, edge.z]]) > PATH_W / 2 + radius
    && lineDistance(x, z, STAIR.line) > STAIR.width / 2 + radius
}
