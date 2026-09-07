import assert from 'node:assert/strict'
import { scatterClear, lineDistance } from '../src/world/scatterClearance'
import { PATH, STAIR } from '../src/world/layout'
import { stairProfile } from '../src/world/stairProfile'

for (const [x, z] of [...PATH, ...STAIR.line]) assert.equal(scatterClear(x, z, 0.1), false)
const { foot, edge } = stairProfile().join
assert.equal(scatterClear((foot.x + edge.x) / 2, (foot.z + edge.z) / 2, 0.1), false)
// Regression: a three-metre boulder whose centre clears the stair can still
// protrude onto its walkable edge. Test the actual oblique stair segment.
const [a, b] = STAIR.line
const x = (a[0] + b[0]) / 2, z = (a[1] + b[1]) / 2
const dx = b[0] - a[0], dz = b[1] - a[1], length = Math.hypot(dx, dz)
const bx = x - dz / length * 4, bz = z + dx / length * 4
assert.ok(lineDistance(bx, bz, STAIR.line) > STAIR.width / 2)
assert.equal(scatterClear(bx, bz, 3), false)
assert.ok(scatterClear(-50, -50, 1))
console.log('Scatter clearance: path, full stair width, boulder radius and connector passed.')
