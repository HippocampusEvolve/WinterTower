/**
 * check.ts — проверки компоновки и прохода. Гоняются при сборке мира,
 * из консоли (`wt.world.check()`) и из схемы плана.
 *
 * Разделение с `layout.ts` не косметическое: расстановка — голые числа без
 * импортов, иначе рельеф не имеет права её читать. Проверки читают всё сразу,
 * поэтому живут отдельно.
 *
 * Что здесь ловится и почему именно это:
 *
 *   — пятна не накладываются, дорожка не заходит в пятна, мачты не в стенах.
 *     Три бага, прожившие по три сессии, были ровно этим (фаза 3.5);
 *   — **проход по маршу считается, а не осматривается.** Проверка плана видит
 *     пятна, но не треугольники: перила, наглухо отгородившие лестницу, она
 *     пропустила, а автопроход в браузере поймал сразу (фаза 3.5). Автопроход
 *     руками — плохая страховка, поэтому теперь по профилю марша (`stairProfile`)
 *     считается то же самое: нет ли ступеньки выше переступа, остаётся ли под
 *     ногу ширина, вровень ли стыки с площадкой и дорожкой.
 */

import { heightAt, slopeAt, highestIn, lowestIn } from './terrain'
import {
  APRON,
  CORRIDOR,
  LATTICE,
  PATH,
  SPOTS,
  STAIR,
  THIN_MASTS,
  insideBy,
  guyAnchors,
  type Spot,
} from './layout'
import { RISE, stairProfile } from './stairProfile'

const overlap = (a: Spot, b: Spot) =>
  Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0) > 0.01 &&
  Math.min(a.z1, b.z1) - Math.max(a.z0, b.z0) > 0.01

/**
 * Максимальная ступенька, которую капсула переступает не прыгая.
 * Радиус капсулы 0.34 (см. player.ts): пока верх препятствия ниже центра нижней
 * сферы, контакт даёт нормаль вверх и игрока выталкивает наверх. Выше — стена.
 */
const STEP_OVER = 0.3

/**
 * Расстояние от точки до оси марша в плане. Марш шириной 6 м, и всё, что ближе
 * трёх метров к его оси, вырастает прямо из ступеней. Так в кадре оказались
 * тонкая мачта и две вешки дорожки: обе стояли по своим правилам, и обе
 * проверки — «не в пятне» и «не на дорожке» — их пропустили.
 */
function distToStair(x: number, z: number): number {
  let best = Infinity
  const l = STAIR.line
  for (let i = 1; i < l.length; i++) {
    const [ax, az] = l[i - 1]
    const [bx, bz] = l[i]
    const dx = bx - ax
    const dz = bz - az
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz)))
    best = Math.min(best, Math.hypot(x - (ax + dx * t), z - (az + dz * t)))
  }
  return best
}

export function checkLayout(): string[] {
  const bad: string[] = []

  for (let i = 0; i < SPOTS.length; i++) {
    for (let j = i + 1; j < SPOTS.length; j++) {
      if (overlap(SPOTS[i], SPOTS[j])) {
        bad.push(`пятна пересекаются: ${SPOTS[i].name} × ${SPOTS[j].name}`)
      }
    }
  }

  // Перепад земли под пятном: цоколь опускается максимум на MAX_DROP, дальше здание повиснет.
  const MAX_DROP = 6
  for (const s of SPOTS) {
    if (s.h === 0) continue
    const drop = highestIn(s.x0, s.x1, s.z0, s.z1) - lowestIn(s.x0, s.x1, s.z0, s.z1)
    if (drop > MAX_DROP) {
      bad.push(`${s.name}: перепад земли ${drop.toFixed(1)} м, цоколь не дотянется (предел ${MAX_DROP})`)
    }
  }

  for (const [x, z] of PATH) {
    for (const s of SPOTS) {
      const d = insideBy(s, x, z, CORRIDOR)
      if (d > 0) bad.push(`дорожка (${x}, ${z}) в коридоре пятна ${s.name} (заход ${d.toFixed(1)} м)`)
    }
    if (slopeAt(x, z) > 0.75) {
      bad.push(`дорожка (${x}, ${z}): уклон местности ${slopeAt(x, z).toFixed(2)} — лента встанет на ребро`)
    }
  }

  const masts: [string, number, number][] = [
    ['решётчатая мачта', LATTICE.x, LATTICE.z],
    ...THIN_MASTS.map(([x, z], i) => [`тонкая мачта ${i}`, x, z] as [string, number, number]),
  ]
  for (const [name, x, z] of masts) {
    for (const s of SPOTS) {
      if (insideBy(s, x, z) > 0) bad.push(`${name} (${x}, ${z}) стоит внутри ${s.name}`)
    }
    for (const [px, pz] of PATH) {
      if (Math.hypot(x - px, z - pz) < CORRIDOR) bad.push(`${name} (${x}, ${z}) стоит на дорожке`)
    }
    if (slopeAt(x, z) > 0.9) {
      bad.push(`${name} (${x}, ${z}): уклон ${slopeAt(x, z).toFixed(2)} — торчит из отвеса`)
    }
    // Запас к ширине марша большой (2 м): мачта в метре от кромки настила
    // в кадре читается ровно как мачта, растущая из лестницы.
    const d = distToStair(x, z)
    if (d < STAIR.width / 2 + 2) {
      bad.push(`${name} (${x}, ${z}) стоит вплотную к маршу (${d.toFixed(1)} м от оси)`)
    }
  }

  // Анкеры оттяжек. Мачта стоять внутри пятна не может — это проверено выше, —
  // но её тросы уходят от неё на 9.5 м, и до фазы 7 один из трёх приземлялся
  // на полу операторской, протыкая по дороге крышу. Проверять надо ровно то,
  // что строится: `guyAnchors()` — тот же вызов, что в `props.ts`.
  // Мерится весь трос, а не анкер: конец за углом здания ещё ничего не значит,
  // диагональ от мачты к нему срезает угол — и внутри комнаты видно то же самое.
  guyAnchors().forEach(([ax, az], k) => {
    for (let t = 0; t <= 1.0001; t += 0.05) {
      const x = LATTICE.x + (ax - LATTICE.x) * t
      const z = LATTICE.z + (az - LATTICE.z) * t
      for (const s of SPOTS) {
        if (insideBy(s, x, z) > 0) {
          bad.push(`оттяжка ${k} идёт сквозь ${s.name} (${x.toFixed(1)}, ${z.toFixed(1)})`)
          return
        }
      }
      for (const [px, pz] of PATH) {
        if (Math.hypot(x - px, z - pz) < CORRIDOR) {
          bad.push(`оттяжка ${k} пересекает дорожку (${x.toFixed(1)}, ${z.toFixed(1)})`)
          return
        }
      }
    }
  })

  bad.push(...checkStairs())
  return bad
}

/**
 * Проход по маршу — тем же счётом, каким марш построен.
 * Проверяется то, обо что игрок уже спотыкался: ступенька выше переступа,
 * заваленная скалой ширина, отвязанный от площадки верх, недосягаемый с дорожки низ.
 */
export function checkStairs(): string[] {
  const bad: string[] = []
  const p = stairProfile()

  // 1. Верх вровень со скалой полки: с площадки сходишь шагом, а не прыжком.
  const rock = highestIn(APRON.x0, APRON.x1, APRON.z0, APRON.z0 + 1.5)
  if (p.topY - rock < 0 || p.topY - rock > STEP_OVER) {
    bad.push(`плита площадки ${p.topY.toFixed(2)} против скалы полки ${rock.toFixed(2)}`)
  }
  // И наоборот: рельеф не должен торчать сквозь плиту выше переступа.
  const bump = highestIn(APRON.x0, APRON.x1, APRON.z0, APRON.z1) - p.topY
  if (bump > STEP_OVER) {
    bad.push(`скала торчит сквозь плиту площадки на ${bump.toFixed(2)} м`)
  }
  // Верх марша обязан быть В пятне площадки, иначе сходить с него некуда.
  const [tx, tz] = STAIR.line[0]
  if (insideBy(APRON, tx, tz, 0.6) < 0) {
    bad.push(`верх марша (${tx}, ${tz}) вне входной площадки`)
  }

  // 2. Профиль: ни одного подъёма выше переступа по всей длине.
  let worst = 0
  let worstT = 0
  for (let i = 1; i < p.pts.length; i++) {
    const up = p.pts[i].y - p.pts[i - 1].y
    if (up > worst) {
      worst = up
      worstT = p.pts[i].t
    }
  }
  if (worst > RISE + 0.01) {
    bad.push(`на марше подъём ${worst.toFixed(2)} м на t=${worstT.toFixed(1)} (ступень ${RISE})`)
  }

  // 3. Ширина под ногу и высота настила над грунтом по всей длине.
  let narrow = Infinity
  let narrowT = 0
  for (let t = 0; t <= p.total; t += 0.5) {
    const w = p.clearWidth(t, p.yAt(t))
    if (w < narrow) {
      narrow = w
      narrowT = t
    }
  }
  if (narrow < 3) {
    const q = p.at(narrowT)
    bad.push(
      `марш завален скалой на t=${narrowT.toFixed(1)} (${q.x.toFixed(1)}, ${q.z.toFixed(1)}): под ногу ${narrow.toFixed(1)} м из ${STAIR.width}`,
    )
  }

  // 4. Стык с дорожкой: пандус ленты должен быть пологим и целиком помещаться
  //    на последнем участке дорожки, иначе лента полезет вверх за её пределами.
  const j = p.join
  const slope = j.rampRise / j.rampLen
  if (slope > 0.5) {
    bad.push(
      `пандус дорожки на площадку: подъём ${j.rampRise.toFixed(2)} м на ${j.rampLen.toFixed(1)} м, уклон ${slope.toFixed(2)}`,
    )
  }
  // Подножие пандуса должно лежать на грунте, а не висеть над ним.
  const gap = j.foot.y - heightAt(j.foot.x, j.foot.z)
  if (Math.abs(gap) > 0.15) {
    bad.push(`подножие пандуса разошлось с землёй на ${gap.toFixed(2)} м`)
  }
  const [ex, ez] = PATH[PATH.length - 1]
  const reach = Math.hypot(ex - j.x, ez - j.z)
  if (reach > 12) {
    bad.push(`дорожка кончается в ${reach.toFixed(1)} м от поворотной площадки — слишком далеко`)
  }
  // Последняя заданная точка дорожки должна лежать ДАЛЬШЕ подножия пандуса,
  // иначе лента, дотянутая до подножия, пойдёт назад сама на себя.
  if (reach < Math.hypot(j.foot.x - j.x, j.foot.z - j.z)) {
    bad.push(`дорожка кончается ближе к маршу (${reach.toFixed(1)} м), чем подножие пандуса — лента пойдёт назад`)
  }

  return bad
}

/** Отчёт для консоли: высоты, дистанции, претензии. Удобно звать из `wt.world.report()`. */
export function layoutReport(eye: { x: number; z: number }): string {
  const rows = SPOTS.map((s) => {
    const cx = (s.x0 + s.x1) / 2
    const cz = (s.z0 + s.z1) / 2
    const hi = highestIn(s.x0, s.x1, s.z0, s.z1)
    const lo = lowestIn(s.x0, s.x1, s.z0, s.z1)
    return `  ${s.name.padEnd(10)} земля ${lo.toFixed(1)}..${hi.toFixed(1)}  дистанция ${Math.hypot(cx - eye.x, cz - eye.z).toFixed(0)} м`
  })
  const p = stairProfile()
  const steps = p.runs.filter((r) => r.kind === 'step').length
  const bad = checkLayout()
  return (
    'компоновка:\n' +
    rows.join('\n') +
    `\n  лестница: ${p.total.toFixed(0)} м, ${steps} ступеней, верх ${p.topY.toFixed(1)}, ` +
    `поворот ${p.join.y.toFixed(1)} (пандус ${p.join.rampRise.toFixed(2)} м на ${p.join.rampLen.toFixed(1)} м), ` +
    `низ ${p.bottom.y.toFixed(1)}\n` +
    `  низ лестницы: (${p.bottom.x.toFixed(1)}, ${p.bottom.z.toFixed(1)}), ` +
    `дистанция ${Math.hypot(p.bottom.x - eye.x, p.bottom.z - eye.z).toFixed(0)} м\n` +
    (bad.length ? '  ПРЕТЕНЗИИ:\n    ' + bad.join('\n    ') : '  проверка зелёная')
  )
}
