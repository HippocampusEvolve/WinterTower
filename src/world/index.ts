/**
 * world/index.ts — сборка мира.
 *
 * Важное разделение: рельеф и свечения идут отдельно от всего остального.
 * В Octree попадают только постройки. Рельеф — нет: 100k треугольников
 * в дереве не нужны, для земли есть аналитическая heightAt (см. terrain.ts).
 * Ореолы — тем более нет: плоское пятно отсвета на дорожке иначе станет
 * невидимой ступенькой под ногами.
 */

import * as THREE from 'three'
import { buildTerrain } from './terrain'
import { buildLake } from './lake'
import { buildBuildings } from './buildings'
import { buildStairs } from './stairs'
import { buildProps } from './props'
import { buildGlows, type Glows } from './glow'
import { createPlan } from './plan'
import { checkLayout, layoutReport } from './check'
import { stairProfile, type Profile } from './stairProfile'

export function buildWorld(): {
  terrain: THREE.Mesh
  solid: THREE.Group
  glows: Glows
  spawn: THREE.Vector3
  yaw: number
  warmCount: number
  check: () => string[]
  report: () => string
  plan: { toggle: () => void }
  /** Профиль лестницы: по нему автопроход телепортируется в узлы маршрута. */
  stair: Profile
  /** Точка под крышей? Спрашивают снег (не сыпать в комнате) и звук (глушить ветер). */
  indoors: (x: number, y: number, z: number) => boolean
  /** Имя помещения под точкой — для отладки из консоли. */
  roomAt: (x: number, y: number, z: number) => string | null
} {
  const terrain = buildTerrain()
  const lake = buildLake()

  const buildings = buildBuildings()
  const props = buildProps()

  const solid = new THREE.Group()
  solid.name = 'solid'
  solid.add(buildings.group, buildStairs(), props.group, lake.props)

  // Лёд идёт вместе с рельефом, а не в `solid`: дно озера — это `heightAt`,
  // и класть плоскость в Octree значит завести вторую, спорящую с ней землю.
  // Туда же — мелкая осыпь: камешек в ладонь размером как препятствие только
  // липнет к ногам, а в кадре работает и без коллизии.
  terrain.add(lake.ice, props.decor)

  const warm = [...buildings.warm, ...props.warm]
  // Отсветы на земле собираются с обеих сторон: у зданий это пятно перед
  // дверью, у реквизита — круг под фонарём, оставленным у порога (фаза 12).
  const glows = buildGlows(warm, [...buildings.spill, ...props.spill])

  // Компоновка проверяется на каждой сборке мира: пятна, дорожка, мачты,
  // и с фазы 3.7 — проход по маршу. Ловит ровно то, чего не видно в коде:
  // дорожку сквозь здание, мачту внутри корпуса, ступеньку выше переступа
  // на стыке лестницы (все три прожили по три сессии).
  const bad = checkLayout()
  if (bad.length) console.warn('[wintertower] компоновка:\n  ' + bad.join('\n  '))

  return {
    terrain,
    solid,
    glows,
    spawn: props.spawn,
    yaw: props.yaw,
    warmCount: warm.length,
    check: checkLayout,
    report: () => layoutReport(props.spawn),
    plan: createPlan(props.spawn),
    stair: stairProfile(),
    // Реестр наполняют сами постройки: пол помещения задаётся зданием,
    // из рельефа его не вычислить.
    // Запас в толщину стены (pad отрицательный — расширяет): помещения
    // описаны по внутренним граням, и без него полоса под самой стеной
    // остаётся «улицей». Лежащий снег в дверных проёмах это уже убрало
    // (`SHELTER_PAD` в materials.ts) — здесь то же самое для летящего:
    // иначе в каждом проёме сыплются хлопья. Наружу запас выходит на 5 см,
    // потому что стены везде толщиной 0.35–0.4.
    indoors: (x, y, z) => buildings.interiors.contains(x, y, z, -0.4),
    roomAt: (x, y, z) => buildings.interiors.nameAt(x, y, z),
  }
}
