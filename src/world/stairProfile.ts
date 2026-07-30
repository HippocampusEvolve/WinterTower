/**
 * stairProfile.ts — профиль главной лестницы: чистая математика, без геометрии.
 *
 * Вынесено из `stairs.ts` по одной причине: **профиль надо уметь проверять
 * без браузера.** Три сессии подряд лестница ломалась так, что в кадре ничего
 * не видно (тонкие трубы в тумане, настил в метре над землёй), а пешком не
 * пройти. Теперь профиль считается здесь, `check.ts` гоняет по нему проверки
 * прохода, а `stairs.ts` только превращает готовые числа в коробки.
 *
 * Правила профиля, каждое оплачено сломанной лестницей:
 *
 * 1. **Настил меряется по ВСЕЙ ширине, а не по оси.** Марш идёт по борту
 *    наискось, поэтому нагорная кромка настила на 2–3 м выше подгорной.
 *    Ставить настил по высоте оси — значит закопать его нагорную половину
 *    в скалу; получается невидимая стенка вдоль всего марша.
 * 2. **Зазор маленький (0.12 м), а не 0.8.** С зазором 0.8 настил всюду висел
 *    почти на метр над грунтом: сойти с него вбок и, главное, ЗАЙТИ на него
 *    с дорожки было нельзя — только прыжком. Ровно на это и жаловались.
 * 3. **Площадки ставит рельеф, а не счётчик ступеней.** На верхнем марше земля
 *    падает под 0.63 м/м — ровно с крутизной лестницы. Любая «обязательная»
 *    площадка через N ступеней съедает спуск, и марш не достаёт до дорожки:
 *    метр площадки = 0.63 м недобранной высоты.
 */

import { heightAt, highestIn } from './terrain'
import { APRON, PATH, STAIR } from './layout'

/** Ступень: подступенок и проступь. Проверено контроллером ещё в фазе 1. */
export const RISE = 0.19
export const RUN = 0.3
/** Насколько настил идёт выше самой высокой земли под своей шириной. */
const CLEAR = 0.12
/** Полуширина, по которой марш обязан быть выше земли. Меньше половины настила:
 *  нагорной кромке позволено уйти в скалу — так марш выглядит врезанным в склон,
 *  а под ногу всё равно остаётся 5 м из шести (проверяется `clearWidth`). */
const HALF = 1.6
/** Шаг площадки: марш «ждёт», пока земля опустится. */
const LAND = 1.0

export type Run = { kind: 'step' | 'landing'; t0: number; t1: number; y: number }

export type Segment = { x0: number; z0: number; ux: number; uz: number; len: number }

export type Profile = {
  segs: Segment[]
  total: number
  /** Отметка верха: вровень с входной площадкой, ступеньки на стыке нет. */
  topY: number
  runs: Run[]
  /** Точки излома профиля — по ним ставятся перила и опоры. */
  pts: { t: number; y: number }[]
  /** `t` изломов плана: там стоят поворотные площадки. */
  vertexT: number[]
  at(t: number): { x: number; z: number; ux: number; uz: number }
  yAt(t: number): number
  /** Самая высокая земля под шириной настила. */
  under(t: number): number
  /** Сколько метров ширины настила реально выше земли — столько и под ногу. */
  clearWidth(t: number, y: number): number
  /**
   * Поворотная площадка у дорожки и пандус к ней:
   * `edge` — верх пандуса на кромке настила, `foot` — его подножие на грунте,
   * куда приходит лента дорожки.
   */
  join: {
    x: number
    z: number
    y: number
    edge: { x: number; z: number; y: number }
    foot: { x: number; z: number; y: number }
    rampLen: number
    rampRise: number
  }
  /** Нижняя площадка: там штольня. `inX/inZ` — куда смотрит портал (в гору). */
  bottom: { x: number; z: number; y: number; ux: number; uz: number; inX: number; inZ: number }
}

let cached: Profile | null = null

export function stairProfile(): Profile {
  if (cached) return cached

  const segs: Segment[] = []
  for (let i = 1; i < STAIR.line.length; i++) {
    const [ax, az] = STAIR.line[i - 1]
    const [bx, bz] = STAIR.line[i]
    const len = Math.hypot(bx - ax, bz - az)
    segs.push({ x0: ax, z0: az, ux: (bx - ax) / len, uz: (bz - az) / len, len })
  }
  const total = segs.reduce((a, s) => a + s.len, 0)

  const vertexT: number[] = []
  for (let i = 0, acc = 0; i < segs.length - 1; i++) {
    acc += segs[i].len
    vertexT.push(acc)
  }

  const at = (t: number) => {
    let r = Math.max(0, Math.min(t, total))
    for (let i = 0; i < segs.length; i++) {
      const s = segs[i]
      if (r <= s.len || i === segs.length - 1) {
        return { x: s.x0 + s.ux * r, z: s.z0 + s.uz * r, ux: s.ux, uz: s.uz }
      }
      r -= s.len
    }
    throw new Error('unreachable')
  }

  const under = (t: number) => {
    const p = at(t)
    let m = -Infinity
    for (let o = -HALF; o <= HALF + 1e-9; o += HALF / 2) {
      m = Math.max(m, heightAt(p.x + p.uz * o, p.z - p.ux * o))
    }
    return m
  }

  const clearWidth = (t: number, y: number) => {
    const p = at(t)
    const half = STAIR.width / 2
    let w = 0
    for (let o = -half; o <= half + 1e-9; o += 0.25) {
      if (heightAt(p.x + p.uz * o, p.z - p.ux * o) < y) w += 0.25
    }
    return w
  }

  // Поворотной площадки на изломе НЕТ, и это осознанно. Первая версия держала
  // ровный квадрат 7 м по обе стороны от поворота — по-архитектурному правильно
  // и геометрически невозможно: 7 м площадки стоят 4.5 м несобранного спуска,
  // а весь верхний марш идёт впритык к предельной крутизне. Марш приходил
  // к дорожке на 3.5 м выше земли, и сход выезжал за её конец. Поворот всего
  // на 12°, ступени спокойно идут насквозь; клин на внешней кромке закрывает
  // отдельная плита в `stairs.ts`.

  // Отметка плиты берётся по СЕВЕРНОЙ кромке площадки — по той полосе, которой
  // она примыкает к ровной скале полки. По всему пятну брать нельзя: южный край
  // висит над скатом, где рельеф гуляет складками, и плита уезжала бы вверх
  // за самой высокой из них, отрастая ступенькой на стыке со скалой.
  //
  // Плюс 5 см: вровень нельзя, на полосе стыка плита и рельеф совпадают по
  // высоте и мерцают z-fighting'ом. 5 см капсула не замечает — она перешагивает
  // всё до 0.3 м (см. check.ts).
  const topY = highestIn(APRON.x0, APRON.x1, APRON.z0, APRON.z0 + 1.5) + 0.05

  const runs: Run[] = []
  let y = topY
  let t = 0
  // Верхняя площадка: с неё сходят на площадку комплекса, поэтому она вровень.
  runs.push({ kind: 'landing', t0: 0, t1: LAND, y })
  t = LAND

  let guard = 0
  while (t < total && guard++ < 4000) {
    if (y - RISE >= under(t + RUN) + CLEAR) {
      y -= RISE
      runs.push({ kind: 'step', t0: t, t1: t + RUN, y })
      t += RUN
    } else {
      const len = Math.min(LAND, total - t)
      runs.push({ kind: 'landing', t0: t, t1: t + len, y })
      t += len
    }
  }

  const pts: { t: number; y: number }[] = [{ t: 0, y: topY }]
  for (const r of runs) pts.push({ t: r.t1, y: r.y })

  const yAt = (q: number) => {
    if (q <= 0) return pts[0].y
    const last = pts[pts.length - 1]
    if (q >= last.t) return last.y
    for (let i = 1; i < pts.length; i++) {
      if (pts[i].t >= q) {
        const a = pts[i - 1]
        const b = pts[i]
        return b.t === a.t ? b.y : a.y + ((b.y - a.y) * (q - a.t)) / (b.t - a.t)
      }
    }
    return last.y
  }

  // --- Выход дорожки на поворотную площадку ----------------------------------
  //
  // Марш приходит к дорожке на полметра-полтора выше земли, и деться от этого
  // некуда: верхний марш идёт впритык к предельной крутизне, а у самой кромки
  // настил ещё и обязан быть выше нагорной земли под своей шириной.
  //
  // Первая версия добирала остаток **отдельным маленьким маршем** от площадки
  // к концу дорожки. Считалось верно, а в кадре выглядело дико: сход стоит
  // под 43° к главному маршу и читается второй лестницей, воткнутой в первую.
  // Теперь остаток добирает сама дорожка: последние метры ленты поднимаются
  // пандусом на площадку. Ступеней в стыке нет вообще, и стык не виден.
  const jT = vertexT[0]
  const jy = yAt(jT)
  const jp = at(jT)
  const [ex, ez] = PATH[PATH.length - 1]
  // Переход с дорожки на марш — отдельный пандус, и вот почему не лента.
  //
  // Дорожка подходит к лестнице почти ВДОЛЬ неё (38° к оси), а не поперёк.
  // Поднимать саму ленту нельзя: её ширина 4.4 м, и последние метры повисают
  // козырьком над ступенями нижнего марша. Доводить ленту до оси — то же самое,
  // только хуже. Поэтому лента честно лежит на грунте до самой кромки настила,
  // а последние полтора метра высоты добирает бетонный пандус.
  //
  // Кромку ищем счётом, а не числом: идём от излома в сторону дорожки, пока
  // не выйдем за габарит настила ОБОИХ маршей — у излома их два, и тот,
  // что уходит вниз, лежит как раз со стороны дорожки.
  const ul = Math.hypot(ex - jp.x, ez - jp.z) || 1
  const ux2 = (ex - jp.x) / ul
  const uz2 = (ez - jp.z) / ul
  /** Расстояние от точки до ломаной марша в плане. */
  const distToLine = (x: number, z: number) => {
    let best = Infinity
    for (let i = 1; i < STAIR.line.length; i++) {
      const [ax, az] = STAIR.line[i - 1]
      const [bx, bz] = STAIR.line[i]
      const dx2 = bx - ax
      const dz2 = bz - az
      const k = Math.max(0, Math.min(1, ((x - ax) * dx2 + (z - az) * dz2) / (dx2 * dx2 + dz2 * dz2)))
      best = Math.min(best, Math.hypot(x - (ax + dx2 * k), z - (az + dz2 * k)))
    }
    return best
  }
  let s = 0
  while (s < 12 && distToLine(jp.x + ux2 * s, jp.z + uz2 * s) < STAIR.width / 2 + 0.2) s += 0.1
  const edge = { x: jp.x + ux2 * s, z: jp.z + uz2 * s, y: jy }
  const rampRise = Math.max(0, edge.y - heightAt(edge.x, edge.z))
  // Уклон держим около 0.32 (18°) — по такому ходят пешком, не замечая подъёма.
  let rampLen = Math.max(1.2, Math.min(8, rampRise / 0.32))
  for (let i = 0; i < 3; i++) {
    const fx = edge.x + ux2 * rampLen
    const fz = edge.z + uz2 * rampLen
    rampLen = Math.max(1.2, Math.min(8, (edge.y - heightAt(fx, fz)) / 0.32))
  }
  const foot = {
    x: edge.x + ux2 * rampLen,
    z: edge.z + uz2 * rampLen,
    y: heightAt(edge.x + ux2 * rampLen, edge.z + uz2 * rampLen),
  }

  // --- Низ: площадка у штольни ------------------------------------------------
  const bp = at(total)
  const by = yAt(total)
  // Портал смотрит в гору: с нагорной стороны есть во что врезаться.
  const side = heightAt(bp.x + bp.uz * 4, bp.z - bp.ux * 4) > heightAt(bp.x - bp.uz * 4, bp.z + bp.ux * 4) ? 1 : -1

  cached = {
    segs,
    total,
    topY,
    runs,
    pts,
    vertexT,
    at,
    yAt,
    under,
    clearWidth,
    join: { x: jp.x, z: jp.z, y: jy, edge, foot, rampLen, rampRise },
    bottom: {
      x: bp.x,
      z: bp.z,
      y: by,
      ux: bp.ux,
      uz: bp.uz,
      inX: bp.uz * side,
      inZ: -bp.ux * side,
    },
  }
  return cached
}
