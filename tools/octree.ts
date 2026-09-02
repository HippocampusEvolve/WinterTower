/**
 * tools/octree.ts — дерево коллизий: во что обходится и то ли получается.
 *
 *     npm run octree
 *
 * Зачем понадобился. Замер входа в мир показал, что после приезда бандла
 * главный поток занят одной задачей почти на две секунды, и сеть всё это время
 * простаивает. Разбивка нашлась в собственном логе игры: мир собирается за
 * 500 мс, а дерево коллизий строится за 1400. Втрое дольше самого мира — и это
 * при том, что рельеф в дерево не идёт вовсе, только постройки.
 *
 * Инструмент отвечает на четыре вопроса подряд, и каждый следующий имеет смысл
 * только при определённом ответе на предыдущий.
 *
 *   1. ГДЕ ВРЕМЯ. `fromGraphNode` делает две разные работы: раскладывает
 *      треугольники по дереву и делит куб на восемь, пока в ячейке не
 *      останется мало геометрии. Первая режется на порции тривиально, вторая —
 *      рекурсия. Ответ: 99% времени во второй.
 *
 *   2. МОЖНО ЛИ ПРОСТО НАСТРОИТЬ ДЕРЕВО. Оно вырождено: на 38 тысяч
 *      треугольников приходится 281 тысяча листьев, и каждый треугольник лежит
 *      в 28 местах. Причина — `split` читает `trianglesPerLeaf` и `maxLevel` у
 *      СЕБЯ, а подузлы заводит через `new Octree(box)`, то есть с заводскими
 *      8 и 16: настройка на корне действует ровно на один уровень. Донести её
 *      до каждого узла можно, и тогда сборка вчетверо быстрее, а запрос втрое.
 *      Но нельзя — см. пункт 3.
 *
 *   3. ОТВЕЧАЕТ ЛИ НАСТРОЕННОЕ ДЕРЕВО ТО ЖЕ САМОЕ. Нет. `capsuleIntersect` не
 *      ищет ближайшее касание: он собирает треугольники-кандидаты и выталкивает
 *      капсулу каждым по очереди, накапливая сдвиг. Крупный лист приносит в
 *      набор больше дальней геометрии, выталкиваний становится больше — и
 *      ходьба по миру меняется. Расходится четверть проб, местами на два метра.
 *      Поэтому настройки остаются заводскими.
 *
 *   4. МОЖНО ЛИ СОБРАТЬ ТО ЖЕ ДЕРЕВО ПО ЧАСТЯМ. Да, и это решение, которое
 *      стоит в мире (`src/world/collision.ts`): рекурсия снята в очередь, и
 *      очередь разбирается порциями между кадрами. Здесь она разбирается
 *      целиком — чтобы сверить, что дерево получается узел в узел, а ответы
 *      не расходятся ни разу.
 */

import * as THREE from 'three'
import { Octree } from 'three/examples/jsm/math/Octree.js'
import { Capsule } from 'three/examples/jsm/math/Capsule.js'

import { buildBuildings } from '../src/world/buildings'
import { buildStairs } from '../src/world/stairs'
import { buildProps } from '../src/world/props'
import { buildLake } from '../src/world/lake'
import { clearFixtures, collectShapes } from '../src/world/fixtures'
import { heightAt } from '../src/world/terrain'
// Сборку зовём ту, что стоит в мире, а не копию: инструмент проверяет
// настоящее дерево игры, иначе он проверяет сам себя.
import { buildCollisionSync, fillOctree } from '../src/world/collision'

// Форма предметов собирается ДО постройки: реестр наполняется по ходу дела
// (тот же порядок, что в world-check-kit).
clearFixtures()
collectShapes(true)

const t0 = performance.now()
const buildings = buildBuildings()
const props = buildProps()
const lake = buildLake()
const solid = new THREE.Group()
solid.name = 'solid'
solid.add(buildings.group, buildStairs(), props.group, lake.props)
const tWorld = performance.now() - t0

// --- Из чего состоит solid ----------------------------------------------------
solid.updateWorldMatrix(true, true)
const meshes: { name: string; tris: number }[] = []
solid.traverse((o) => {
  const m = o as THREE.Mesh
  if (!m.isMesh) return
  const idx = m.geometry.index
  const count = idx ? idx.count : m.geometry.getAttribute('position').count
  meshes.push({
    name: m.name || m.geometry.type,
    // Инстансы дают по копии геометрии на каждый экземпляр — считаем честно.
    tris: (count / 3) * ((m as unknown as THREE.InstancedMesh).count ?? 1),
  })
})
const totalTris = meshes.reduce((s, m) => s + m.tris, 0)

console.log(`\nМир (без рельефа) собран за ${tWorld.toFixed(0)} мс`)
console.log(`В дерево идёт: ${meshes.length} мешей, ${totalTris.toFixed(0)} треугольников\n`)
console.log('Самые крупные меши:')
for (const m of meshes.sort((a, b) => b.tris - a.tris).slice(0, 8)) {
  console.log(`  ${String(Math.round(m.tris)).padStart(7)} треуг  ${m.name}`)
}

// --- 1. Где время --------------------------------------------------------------
console.log('\n1. Две фазы порознь (среднее по трём прогонам):')
let sumFill = 0
let sumBuild = 0
for (let run = 0; run < 3; run++) {
  const tree = new Octree()
  const a = performance.now()
  fillOctree(tree, solid)
  const b = performance.now()
  tree.build()
  sumBuild += performance.now() - b
  sumFill += b - a
}
const avgFill = sumFill / 3
const avgBuild = sumBuild / 3
const avgTotal = avgFill + avgBuild
console.log(
  `   разложить треугольники ${avgFill.toFixed(0).padStart(5)} мс  ` +
    `(${((avgFill / avgTotal) * 100).toFixed(0)}%)`,
)
console.log(
  `   поделить на ячейки     ${avgBuild.toFixed(0).padStart(5)} мс  ` +
    `(${((avgBuild / avgTotal) * 100).toFixed(0)}%)`,
)

/** Обойти дерево и посчитать, что в нём выросло. */
function shape(tree: Octree): { nodes: number; leaves: number; depth: number; stored: number } {
  let nodes = 0
  let leaves = 0
  let depth = 0
  let stored = 0
  const walk = (t: Octree, level: number): void => {
    nodes += 1
    if (level > depth) depth = level
    stored += t.triangles.length
    if (!t.subTrees.length) leaves += 1
    else for (const s of t.subTrees) walk(s, level + 1)
  }
  walk(tree, 0)
  return { nodes, leaves, depth, stored }
}

const plain = new Octree()
fillOctree(plain, solid)
plain.build()
const sp = shape(plain)
console.log('\n   что выросло:')
console.log(`   узлов ${sp.nodes}, из них листьев ${sp.leaves}, глубина ${sp.depth}`)
console.log(
  `   треугольников разложено ${sp.stored} при ${totalTris.toFixed(0)} настоящих — ` +
    `каждый лежит в ${(sp.stored / totalTris).toFixed(1)} местах`,
)

// --- 2. Что даёт настройка дерева ------------------------------------------------
/**
 * Собрать дерево с настройками, доходящими до каждого узла.
 *
 * `split` читает их у себя, а узлы рождаются в ходе рекурсии, и дотянуться до
 * них заранее нельзя. Поэтому на время сборки подменяется сам `split`.
 */
function buildTuned(perLeaf: number, maxLevel: number): Octree {
  const tree = new Octree()
  fillOctree(tree, solid)
  tree.calcBox()
  const proto = Object.getPrototypeOf(tree) as { split: (level: number) => Octree }
  const origSplit = proto.split
  proto.split = function patched(this: Octree, level: number) {
    this.trianglesPerLeaf = perLeaf
    this.maxLevel = maxLevel
    return origSplit.call(this, level)
  }
  try {
    tree.split(0)
  } finally {
    proto.split = origSplit
  }
  return tree
}

// Запрос меряем на настоящей капсуле игрока в настоящей точке мира: цена
// запроса зависит от того, сколько треугольников рядом, а не от среднего.
const RADIUS = 0.34
const spawnX = 2.5
const spawnZ = 8.4
const spawnY = heightAt(spawnX, spawnZ) + 1.7
const capsuleAt = (x = spawnX, y = spawnY, z = spawnZ) =>
  new Capsule(new THREE.Vector3(x, y, z), new THREE.Vector3(x, y + 1.34, z), RADIUS)

console.log('\n2. Если донести настройки до каждого узла:')
console.log('   лист  глубина    сборка   1000 запросов   листьев   копий')
for (const [perLeaf, maxLevel] of [
  [8, 16],
  [16, 10],
  [32, 8],
  [64, 6],
  [128, 6],
] as [number, number][]) {
  const a = performance.now()
  const tree = buildTuned(perLeaf, maxLevel)
  const built = performance.now() - a

  const capsule = capsuleAt()
  const q = performance.now()
  for (let i = 0; i < 1000; i++) tree.capsuleIntersect(capsule)
  const query = performance.now() - q

  const s = shape(tree)
  console.log(
    `   ${String(perLeaf).padStart(4)}  ${String(maxLevel).padStart(7)}  ` +
      `${built.toFixed(0).padStart(6)} мс  ${query.toFixed(1).padStart(11)} мс  ` +
      `${String(s.leaves).padStart(8)}  ${(s.stored / totalTris).toFixed(1).padStart(6)}`,
  )
}

// --- Сверка ответов двух деревьев --------------------------------------------------
//
// Дерево — указатель, где искать, и на первый взгляд обязано давать один и тот
// же ответ, как его ни дели. На деле нет: выталкивание идёт треугольник за
// треугольником и некоммутативно, а набор кандидатов зависит от разбиения.
//
// Разбираем по глубине проникновения. Физика зовёт дерево не откуда попало:
// игрок движется подшагами и утапливается в стену на миллиметры, а не на метры.
// Точка, где капсула сидит внутри скалы на полметра, — не рабочий режим, и
// сравнивать там нечего: глубоко внутри тела любые два дерева разойдутся, даже
// одинаково правильные.
function compare(
  a: Octree,
  b: Octree,
): {
  touched: number
  bands: { name: string; limit: number; n: number; bad: number }[]
  workingBad: number
  worstDepth: number
} {
  const bands = [
    { name: 'до 5 см', limit: 0.05, n: 0, bad: 0 },
    { name: 'до 34 см', limit: RADIUS, n: 0, bad: 0 },
    { name: 'до 1 м', limit: 1, n: 0, bad: 0 },
    { name: 'глубже 1 м', limit: Infinity, n: 0, bad: 0 },
  ]
  let touched = 0
  let workingBad = 0
  let worstDepth = 0
  for (let x = -40; x <= 40; x += 0.5) {
    for (let z = -40; z <= 40; z += 0.5) {
      // Три высоты: по земле, по пояс над ней и на уровне второго яруса —
      // лестница и терраса иначе не попадут под проверку вовсе.
      for (const lift of [0, 1.2, 5]) {
        const y = heightAt(x, z) + lift
        const ra = a.capsuleIntersect(capsuleAt(x, y, z))
        const rb = b.capsuleIntersect(capsuleAt(x, y, z))
        if (!ra && !rb) continue
        touched += 1
        const band = bands.find((v) => (ra ? ra.depth : Infinity) <= v.limit)!
        band.n += 1
        // Порог — не «сколько не жалко», а машинная точность float32, в
        // которой лежат координаты вершин.
        const bad =
          !ra ||
          !rb ||
          ra.normal.distanceTo(rb.normal) > 1e-6 ||
          Math.abs(ra.depth - rb.depth) > 1e-6
        if (!bad) continue
        band.bad += 1
        if (ra && ra.depth <= RADIUS) {
          workingBad += 1
          if (rb) worstDepth = Math.max(worstDepth, Math.abs(ra.depth - rb.depth))
        }
      }
    }
  }
  return { touched, bands, workingBad, worstDepth }
}

// --- 3. Отвечает ли настроенное дерево то же самое ----------------------------------
const TUNED = { perLeaf: 64, maxLevel: 6 }
const vsTuned = compare(plain, buildTuned(TUNED.perLeaf, TUNED.maxLevel))
console.log(
  `\n3. Настроенное дерево (лист ${TUNED.perLeaf}, глубина ${TUNED.maxLevel}) ` +
    `против нынешнего, касаний ${vsTuned.touched}:`,
)
for (const b of vsTuned.bands) {
  console.log(
    `   ${b.name.padEnd(11)} проб ${String(b.n).padStart(6)}, ` +
      `расходится ${String(b.bad).padStart(5)} ` +
      `(${b.n ? ((b.bad / b.n) * 100).toFixed(1) : '0.0'}%)`,
  )
}
console.log(
  `   в рабочем режиме физики (до ${RADIUS} м) расхождений ${vsTuned.workingBad}, ` +
    `худшее по глубине ${vsTuned.worstDepth.toFixed(2)} м`,
)
console.log(
  vsTuned.workingBad === 0
    ? '   ответы те же — настройку можно было бы поставить в мир\n'
    : '   ОТВЕТЫ ДРУГИЕ — настройки дерева не трогаем\n',
)

// --- 4. То же дерево, но собранное очередью -----------------------------------------
const q0 = performance.now()
const queued = buildCollisionSync(solid)
const queuedMs = performance.now() - q0
const sq = shape(queued)
const sameShape =
  sq.nodes === sp.nodes &&
  sq.leaves === sp.leaves &&
  sq.depth === sp.depth &&
  sq.stored === sp.stored

console.log('4. Сборка очередью вместо рекурсии (src/world/collision.ts):')
console.log(`   ${queuedMs.toFixed(0)} мс`)
console.log(
  `   форма: узлов ${sq.nodes}, листьев ${sq.leaves}, глубина ${sq.depth}, ` +
    `копий ${sq.stored} — ${sameShape ? 'совпадает' : 'НЕ СОВПАДАЕТ'}`,
)
// Форма может совпасть случайно — сверяем ещё и ответы, той же сеткой.
const vsQueued = compare(plain, queued)
console.log(`   ответы: касаний ${vsQueued.touched}, расхождений ${vsQueued.workingBad}`)
console.log(
  sameShape && vsQueued.workingBad === 0
    ? '\nОчередь даёт то же дерево и те же ответы — её и разбираем по кадрам.\n'
    : '\nОЧЕРЕДЬ ДАЁТ ДРУГОЕ ДЕРЕВО — в мир не ставим.\n',
)
