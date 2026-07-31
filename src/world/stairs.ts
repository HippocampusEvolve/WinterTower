/**
 * stairs.ts — длинный марш по скальному борту.
 *
 * Главная линия композиции референса: лестница уходит от корпусов вниз-влево
 * и срезается краем кадра. Здесь она ещё и работает как дорога: сверху выходит
 * на входную площадку комплекса, посередине встречается с дорожкой, снизу
 * упирается в ворота штольни — то есть ведёт куда-то, а не обрывается.
 *
 * Числа профиля целиком в `stairProfile.ts`, здесь только коробки. Это
 * разделение и есть главный вывод фазы 3.7: профиль должен считаться и
 * проверяться без браузера, иначе непроходимый марш живёт по три сессии.
 */

import * as THREE from 'three'
import { MAT } from './materials'
import { Parts, rng } from './parts'
import { heightAt } from './terrain'
import { PATH, STAIR } from './layout'
import { RISE, stairProfile } from './stairProfile'

const WIDTH = STAIR.width // 6 м — замер по референсу, шеренга на ступени

export function buildStairs(): THREE.Group {
  const group = new THREE.Group()
  group.name = 'stairs'

  const deck = new Parts()
  const rail = new Parts()
  const wall = new Parts()
  const snow = new Parts()
  // Ворота штольни — единственная ржавая поверхность лестницы. Отдельный
  // сборщик ради одной плоскости оправдан тем, что она сюжетная: закрытый
  // ход в скалу и должен выглядеть не тронутым дольше всего остального.
  const rust = new Parts()

  const p = stairProfile()
  const yawAt = (t: number) => {
    const s = p.at(t)
    return Math.atan2(s.ux, s.uz)
  }

  // --- Настил ----------------------------------------------------------------
  // Снег на проступях. Марш — главная линия композиции, и на референсе он
  // читается именно чередой белых полос: голый металл в тумане теряется.
  // Ложится не на все ступени и не во всю ширину: по лестнице ходят, середина
  // вытоптана. `rng` детерминированный — рисунок не пляшет от перезагрузки.
  const rand = rng(60724)
  for (const r of p.runs) {
    const mid = (r.t0 + r.t1) / 2
    const c = p.at(mid)
    const len = r.t1 - r.t0
    const yaw = yawAt(mid)
    if (r.kind === 'step') {
      // Ступень уходит вниз с запасом: соседние перекрываются, щелей нет.
      deck.box(WIDTH, 0.52, len, c.x, r.y - 0.26 + RISE, c.z, yaw)
      if (rand() < 0.62) {
        // Полоса смещена к одному из бортов: снег держится там, где не ходят.
        const side = (rand() < 0.5 ? -1 : 1) * (0.16 + rand() * 0.12)
        const w = WIDTH * (0.34 + rand() * 0.3)
        snow.box(w, 0.05, len * 0.92, c.x + c.uz * WIDTH * side, r.y + RISE + 0.02, c.z - c.ux * WIDTH * side, yaw)
      }
    } else {
      // Без нахлёста по длине. Он тут был симметричным (+0.3 на обе стороны)
      // и лез под соседнюю ступень, у которой проступь стоит на ТОЙ ЖЕ
      // отметке: площадка кончается на `y`, а следующая ступень с этой же `y`
      // начинается. Две грани вверх в одной плоскости — полосы поперёк марша.
      // Щели от снятия нахлёста не будет: куски стыкуются гранями встык.
      deck.box(WIDTH, 0.34, len, c.x, r.y - 0.17, c.z, yaw)
      snow.box(WIDTH * 0.86, 0.05, len * 0.9, c.x, r.y + 0.02, c.z, yaw)
    }
  }

  // Клин на изломе плана. Два марша сходятся под 12°, и на внешней кромке
  // между их коробками остаётся треугольная дыра шириной под метр. Закрывающая
  // плита сажается на ступень НИЖЕ настила: вровень она встала бы порогом
  // поперёк марша, а снизу её просто не видно.
  for (const vt of p.vertexT) {
    const c = p.at(vt)
    const yaw = (yawAt(vt - 0.6) + yawAt(vt + 0.6)) / 2
    // Плита повёрнута на СРЕДНИЙ угол двух маршей, поэтому её грани идут почти
    // параллельно их граням — и на прежней отметке расходились с ними на 2-4 мм.
    // Для глубинного буфера это и есть спор: на таком расстоянии он выбирает
    // между поверхностями по пикселям. Плита ушла ниже и стала шире марша:
    // и то и другое разводит грани на сантиметры, а видно её всё равно снизу.
    deck.box(WIDTH + 0.06, 0.4, 1.2, c.x, p.yAt(vt) - RISE - 0.23, c.z, yaw)
  }

  // Стыка с дорожкой здесь нет и быть не должно: последние метры ленты сами
  // поднимаются пандусом на поворотную площадку (props.ts). Отдельный марш
  // от площадки к дорожке читался второй лестницей, воткнутой в первую.

  // --- Перила ----------------------------------------------------------------
  // Проём у поворотной площадки со стороны дорожки обязателен: перила идут
  // по обеим кромкам марша, и доведённые до конца они отгораживают сход.
  // В кадре этого не видно (тонкие трубы в тумане), а пешком не пройти —
  // ровно так лестница простояла отгороженной с фазы 2 до 3.5.
  const jSide = (() => {
    const v = p.vertexT[0]
    const c = p.at(v)
    const [ex, ez] = PATH[PATH.length - 1]
    return c.uz * (ex - c.x) - c.ux * (ez - c.z) > 0 ? 1 : -1
  })()
  const GAP = WIDTH * 0.9
  const POST = 1.6

  for (const side of [-1, 1]) {
    const off = side * (WIDTH / 2 - 0.12)
    let prev: [number, number, number] | null = null
    for (let q = 0; q <= p.total; q += POST) {
      const skipJoin = side === jSide && Math.abs(q - p.vertexT[0]) < GAP
      const skipBottom = side === bottomSide() && q > p.total - GAP
      if (skipJoin || skipBottom) {
        prev = null
        continue
      }
      const c = p.at(q)
      const x = c.x + c.uz * off
      const z = c.z - c.ux * off
      const base = p.yAt(q)
      rail.pipe(0.045, 1.05, x, base, z, 5)
      const top: [number, number, number] = [x, base + 1.05, z]
      if (prev) {
        rail.strut(0.05, prev[0], prev[1], prev[2], top[0], top[1], top[2])
        rail.strut(0.035, prev[0], prev[1] - 0.45, prev[2], top[0], top[1] - 0.45, top[2])
      }
      prev = top
    }
  }

  // --- Опоры -----------------------------------------------------------------
  // Там, где настил висит над скалой, вниз уходят стойки. Без них марш
  // читается как парящая лента.
  for (let q = 0; q <= p.total; q += 5.1) {
    const y0 = p.yAt(q)
    const c = p.at(q)
    for (const side of [-1, 1]) {
      const off = side * (WIDTH / 2 - 0.15)
      const x = c.x + c.uz * off
      const z = c.z - c.ux * off
      const g = heightAt(x, z)
      if (y0 - g > 0.35) rail.pipe(0.075, y0 - g, x, g, z, 5)
    }
  }

  // --- Низ: площадка и ворота штольни ----------------------------------------
  // На референсе лестница уходит вниз за край кадра, и это единственное место,
  // где мир обязан продолжаться за пределами картинки. Пустой обрыв марша
  // читается как недоделка, поэтому внизу — врезанная в скалу подпорная стенка
  // с закрытыми воротами: дальше ход есть, просто он не для нас.
  {
    const b = p.bottom
    const yaw = Math.atan2(b.ux, b.uz)
    const y = b.y
    /** Точка в осях марша: `a` вдоль хода, `s` в гору. */
    const at = (a: number, s: number): [number, number] => [
      b.x + b.ux * a + b.inX * s,
      b.z + b.uz * a + b.inZ * s,
    ]

    // Площадка начинается РОВНО там, где кончается марш (a = 0), а не заезжает
    // под него: заезжая, она клала свой верх в ту же плоскость, что верх нижней
    // ступени-площадки марша, и обе смотрели вверх — 6.2 м² полос под ногами
    // на самом видном месте. Щели от этого нет, куски стыкуются гранями.
    const [px, pz] = at(1.95, 0)
    deck.box(WIDTH, 0.4, 3.9, px, y - 0.2, pz, yaw)

    // Подпорная стенка по нагорной кромке площадки, в ней проём.
    const B = WIDTH / 2 + 0.25
    const H = 3.4
    const seg = (a0: number, a1: number, y0: number, h: number) => {
      const [wx, wz] = at((a0 + a1) / 2, B)
      wall.box(0.5, h, a1 - a0, wx, y0 + h / 2, wz, yaw)
    }
    seg(-1.5, -1.0, y, H)
    seg(1.0, 3.9, y, H)
    seg(-1.0, 1.0, y + 2.4, H - 2.4) // перемычка над проёмом
    // Ворота: тёмный металл в глубине проёма. Не чёрный провал — черноты
    // в кадре нет вовсе (`docs/REFERENCE.md`, 2.2), и закрытые ворота честнее:
    // ход есть, просто он не для нас.
    {
      const [gx, gz] = at(0, B + 0.22)
      rust.add(
        new THREE.PlaneGeometry(2.0, 2.4),
        gx,
        y + 1.2,
        gz,
        0,
        Math.atan2(-b.inX, -b.inZ),
        0,
      )
    }
    // Стойки опор под площадкой: она вынесена над склоном.
    for (const [a, s] of [
      [-1.2, -2.7],
      [3.6, -2.7],
      [3.6, 2.7],
    ] as const) {
      const [sx, sz] = at(a, s)
      const g = heightAt(sx, sz)
      if (y - g > 0.35) rail.pipe(0.09, y - g, sx, g, sz, 5)
    }
    // Перила по открытой, подгорной кромке площадки.
    let prev: [number, number, number] | null = null
    for (let a = -1.5; a <= 3.9; a += 1.35) {
      const [rx, rz] = at(a, -B)
      rail.pipe(0.045, 1.05, rx, y, rz, 5)
      const top: [number, number, number] = [rx, y + 1.05, rz]
      if (prev) rail.strut(0.05, prev[0], prev[1], prev[2], top[0], top[1], top[2])
      prev = top
    }
  }

  group.add(
    deck.mesh(MAT.deck, 'stair-deck'),
    rail.mesh(MAT.metalDark, 'stair-rails'),
    wall.mesh(MAT.concreteDark, 'stair-adit'),
    rust.mesh(MAT.rust, 'adit-gate'),
    snow.mesh(MAT.snow, 'stair-snow'),
  )
  return group
}

/** С какой стороны у нижней площадки стенка: там перила не нужны. */
function bottomSide(): number {
  const b = stairProfile().bottom
  // inX/inZ — единичный вектор в гору; в осях перил это знак смещения.
  return b.uz * b.inX - b.ux * b.inZ > 0 ? 1 : -1
}
