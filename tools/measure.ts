/**
 * tools/measure.ts — замер мира на Node, без браузера.
 *
 *     npm run measure
 *
 * Зачем отдельный инструмент. Половина ошибок этого проекта — геометрические:
 * марш не достаёт до дорожки, площадка не совпадает с рельефом, объект уехал
 * из кадра. Все они видны в числах, но ловились скриншотами и ручным
 * автопроходом в браузере — то есть медленно и не каждый раз.
 *
 * Здесь берутся НАСТОЯЩИЕ модули мира (rolldown собирает их как есть, копий
 * формул нет — ровно на копиях в фазе 3.5 разъехались три бага), и по ним
 * считается: проверка компоновки, профиль лестницы, проекция ключевых точек
 * на кадр 1242×719 против пиксельных мишеней `docs/SCALE.md`.
 *
 * Чего этот инструмент НЕ заменяет: гамму (нужен рендер) и коллизии
 * (нужен Octree с треугольниками). Для них — браузер.
 */

import { floorOf, heightAt, highestIn, slopeAt } from '../src/world/terrain'
import { APRON, CORE, DOME, DOME_BASE, PATH, STAIR, TERRACE } from '../src/world/layout'
import { stairProfile } from '../src/world/stairProfile'
import { checkLayout, layoutReport } from '../src/world/check'

const f = (v: number, w = 6, d = 2) => v.toFixed(d).padStart(w)

// --- Точка съёмки: та же, что у props.ts --------------------------------------
const tTop = highestIn(TERRACE.x0, TERRACE.x1, TERRACE.z0, TERRACE.z1) + TERRACE.lift
const eye = { x: 2.5, y: tTop + 0.1 + 1.68, z: 8.4 }
const YAW = 0.14
const FOCAL = 719 / 2 / Math.tan(((62 / 2) * Math.PI) / 180) // 598 px, см. docs/SCALE.md

/** Проекция мировой точки на кадр 1242×719. Ось Y камеры горизонтальна (тангаж 0). */
function project(x: number, y: number, z: number): [number, number, number] {
  const dx = x - eye.x
  const dz = z - eye.z
  const c = Math.cos(YAW)
  const s = Math.sin(YAW)
  const depth = -(dx * s + dz * c)
  return [621 + (FOCAL * (dx * c - dz * s)) / depth, 359.5 - (FOCAL * (y - eye.y)) / depth, depth]
}

const p = stairProfile()

console.log(layoutReport(eye))

// --- Профиль лестницы ---------------------------------------------------------
console.log('\n== профиль лестницы ==')
console.log('    t       x        z   настил   земля  под настилом  под ногу')
for (let t = 0; t <= p.total + 0.01; t += 4) {
  const c = p.at(t)
  const y = p.yAt(t)
  console.log(
    `${f(t, 5, 1)} ${f(c.x)} ${f(c.z, 8)} ${f(y, 8)} ${f(heightAt(c.x, c.z))} ${f(p.under(t), 12)} ${f(p.clearWidth(t, y), 9)}`,
  )
}
{
  const j = p.join
  const [ex, ez] = PATH[PATH.length - 1]
  console.log(
    `\nповорот (${f(j.x)},${f(j.z)}) настил ${f(j.y)}, земля ${f(heightAt(j.x, j.z))}\n` +
      `пандус дорожки: подъём ${f(j.rampRise)} м на ${f(j.rampLen)} м, уклон ${f(j.rampRise / j.rampLen)}\n` +
      `последняя точка дорожки (${f(ex)},${f(ez)}) — до площадки ${f(Math.hypot(ex - j.x, ez - j.z))} м`,
  )
  const b = p.bottom
  console.log(`низ (${f(b.x)},${f(b.z)}) настил ${f(b.y)}, земля ${f(heightAt(b.x, b.z))}`)
}

// --- Кадр ---------------------------------------------------------------------
// Мишени — из docs/SCALE.md §6 (пиксели референса).
console.log('\n== проекция на кадр 1242×719 из точки спавна ==')
// Пол комплекса — по пятнам, а не числами: в фазе 3.8 мир сжали по глубине,
// и зашитая здесь копия старой рамки честно продолжила мерить пустую скалу.
// Формула больше не повторяется и здесь: `floorOf` знает и про подъём пятна
// (`Spot.lift`), которого у зашитой копии не было бы.
const floor = floorOf(DOME_BASE)
const marks: [string, number, number, number, string][] = [
  ['купол, левый край', DOME.x - DOME.r, floor + DOME.drumH + DOME_BASE.h, DOME.z, 'x 469'],
  ['купол, правый край', DOME.x + DOME.r, floor + DOME.drumH + DOME_BASE.h, DOME.z, 'x 625'],
  ['купол, верх', DOME.x, floor + DOME_BASE.h + DOME.drumH + DOME.r, DOME.z, 'y 64'],
  ['верх лестницы', STAIR.line[0][0], p.topY, STAIR.line[0][1], '(772, 292)'],
  ['пол комплекса', DOME.x, floor, (DOME_BASE.z0 + DOME_BASE.z1) / 2 + DOME.r, 'y 250'],
  ['кромка площадки, лево', APRON.x0, p.topY, APRON.z1, '—'],
  ['кромка площадки, право', APRON.x1, p.topY, APRON.z1, '—'],
  ['поворот у дорожки', p.join.x, p.join.y, p.join.z, '—'],
  ['низ лестницы', p.bottom.x, p.bottom.y, p.bottom.z, 'за нижним краем'],
]
for (const [name, x, y, z, target] of marks) {
  const [sx, sy, d] = project(x, y, z)
  const io = sx >= 0 && sx <= 1242 && sy >= 0 && sy <= 719 ? '  ' : ' ←вне кадра'
  console.log(`${name.padEnd(24)} (${f(sx, 6, 0)},${f(sy, 5, 0)}) ${f(d, 5, 0)} м  мишень ${target}${io}`)
}

// --- Складчатость борта -------------------------------------------------------
// «Гладкая белая стена» из открытых проблем: мерим невязку от локальной
// плоскости на базе 6 м — это и есть то, что глаз читает как складки.
// Окно — левый борт: та же рамка, что в фазе 3.7 (z −70…−20, x −34…−4),
// проведённая через сжатие фазы 3.8. Брать новую нельзя: метрика сравнивается
// с прошлыми сессиями, а на другом куске борта числа значат другое.
let sum = 0
let n = 0
let peak = 0
for (let z = -46; z <= -13; z += 1.65)
  for (let x = -22; x <= -3.5; x += 1.0) {
    const e = 3
    const r =
      heightAt(x, z) -
      (heightAt(x + e, z) + heightAt(x - e, z) + heightAt(x, z + e) + heightAt(x, z - e)) / 4
    sum += Math.abs(r)
    n++
    peak = Math.max(peak, Math.abs(r))
  }
console.log(`\nборт: средняя |невязка| ${f(sum / n)} м, максимум ${f(peak)} м (до фазы 3.7 — 0.30 / 0.76)`)

// --- Итог ---------------------------------------------------------------------
const bad = checkLayout()
console.log(
  '\n' + (bad.length ? `ПРОВЕРКА: ${bad.length} претензий\n  ` + bad.join('\n  ') : 'ПРОВЕРКА ЗЕЛЁНАЯ'),
)
console.log(`уклон у конца дорожки ${f(slopeAt(PATH[PATH.length - 1][0], PATH[PATH.length - 1][1]))}`)
process.exit(bad.length ? 1 : 0)
