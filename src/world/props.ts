/**
 * props.ts — всё, что стоит на рельефе: дорожка, смотровая площадка, перила,
 * мачты, антенны, короба вентиляции, валуны, вешки.
 *
 * Здесь же задаётся точка спавна: игрок должен вставать туда, откуда снят
 * референс — на верхнюю площадку, ~8 м над дорожкой, взглядом вдоль прохода.
 */

import * as THREE from 'three'
import { MAT } from './materials'
import { Parts, keepUV, rng } from './parts'
import { floorOf, heightAt, highestIn, lowestIn, slopeAt } from './terrain'
import {
  PATH,
  PATH_W,
  WING_PLAN,
  TERRACE,
  APRON,
  WING,
  CORE,
  LATTICE,
  THIN_MASTS,
  STAIR,
  CORRIDOR,
  guyAnchors,
} from './layout'
import { stairProfile } from './stairProfile'
import type { Warm } from './glow'

/** Полилиния, пересемплированная с постоянным шагом: лента должна лечь по рельефу. */
function resample(pts: ReadonlyArray<readonly [number, number]>, step: number) {
  const out: [number, number][] = []
  for (let i = 1; i < pts.length; i++) {
    const [x0, z0] = pts[i - 1]
    const [x1, z1] = pts[i]
    const n = Math.max(1, Math.round(Math.hypot(x1 - x0, z1 - z0) / step))
    for (let k = 0; k < n; k++) {
      const t = k / n
      out.push([x0 + (x1 - x0) * t, z0 + (z1 - z0) * t])
    }
  }
  out.push([pts[pts.length - 1][0], pts[pts.length - 1][1]])
  return out
}

/** Лента дорожки по рельефу. Тонкая: игрок всё равно стоит на ней, Octree её видит. */
function ribbon(line: [number, number][], width: number): THREE.BufferGeometry {
  const position: number[] = []
  const uv: number[] = []
  const index: number[] = []
  let run = 0

  for (let i = 0; i < line.length; i++) {
    const [x, z] = line[i]
    const [ax, az] = line[Math.max(0, i - 1)]
    const [bx, bz] = line[Math.min(line.length - 1, i + 1)]
    let dx = bx - ax
    let dz = bz - az
    const l = Math.hypot(dx, dz) || 1
    dx /= l
    dz /= l
    // Кромку слегка «съедает» снегом: идеально ровный борт читается наклейкой.
    const wl = width / 2 - 0.35 * (1 + Math.sin(z * 0.7 + 1.3))
    const wr = width / 2 - 0.35 * (1 + Math.sin(z * 0.53))
    const ox = dz * wl
    const oz = -dx * wl

    position.push(x + ox, heightAt(x + ox, z + oz) + 0.1, z + oz)
    position.push(x - dz * wr, heightAt(x - dz * wr, z + dx * wr) + 0.1, z + dx * wr)
    if (i > 0) run += Math.hypot(x - line[i - 1][0], z - line[i - 1][1])
    // UV в метрах: поперёк — фактическая полуширина кромки, вдоль — пройденный
    // путь. Материал сам решит размер зерна (`meters` в `materials.ts`).
    uv.push(-wl, run, wr, run)
  }
  for (let i = 0; i < line.length - 1; i++) {
    const a = i * 2
    const b = a + 1
    const c = a + 2
    const d = a + 3
    index.push(a, b, c, b, d, c) // обход даёт нормаль вверх
  }

  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.Float32BufferAttribute(position, 3))
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2))
  geo.setIndex(index)
  geo.computeVertexNormals()
  return geo
}

/** Прямой марш вдоль -Z: со смотровой площадки на дорожку. */
function flightDownZ(p: Parts, x: number, zTop: number, yTop: number, yBottom: number, w: number) {
  const RISE = 0.19
  const RUN = 0.3
  const n = Math.max(1, Math.round((yTop - yBottom) / RISE))
  for (let i = 0; i < n; i++) {
    p.box(w, 0.52, RUN, x, yTop - i * RISE - 0.26, zTop - i * RUN - RUN / 2)
  }
  return { z: zTop - n * RUN, y: yTop - n * RISE }
}

/** Перила по списку точек в плане. Уровень основания задаётся функцией: земля или плита. */
function railing(
  p: Parts,
  pts: [number, number][],
  baseAt: (x: number, z: number) => number,
  height = 1.05,
) {
  let prev: [number, number, number] | null = null
  for (const [x, z] of pts) {
    const base = baseAt(x, z)
    p.pipe(0.05, height, x, base, z, 5)
    const top: [number, number, number] = [x, base + height, z]
    if (prev) {
      p.strut(0.045, prev[0], prev[1], prev[2], top[0], top[1], top[2])
      p.strut(0.035, prev[0], prev[1] - 0.42, prev[2], top[0], top[1] - 0.42, top[2])
    }
    prev = top
  }
}

/**
 * Провисающий трос между двумя точками — цепная линия ломаной.
 *
 * Оттяжки мачт и кабель от корпуса к ней читаются в кадре еле-еле, но именно
 * они выдают инженерное сооружение: голая мачта без растяжек выглядит
 * декорацией. Провис обязателен — натянутая по линейке нить читается краем
 * полигона, а не тросом.
 */
function sag(
  p: Parts,
  ax: number,
  ay: number,
  az: number,
  bx: number,
  by: number,
  bz: number,
  drop: number,
  seg = 7,
  r = 0.02,
) {
  let px = ax
  let py = ay
  let pz = az
  for (let i = 1; i <= seg; i++) {
    const t = i / seg
    const x = ax + (bx - ax) * t
    const z = az + (bz - az) * t
    // Парабола вместо честного гиперболического косинуса: на семи сегментах
    // разница меньше сантиметра, а формула читается с одного взгляда.
    const y = ay + (by - ay) * t - drop * 4 * t * (1 - t)
    p.strut(r, px, py, pz, x, y, z, 4)
    px = x
    py = y
    pz = z
  }
}

/** Решётчатая мачта: четыре стойки + крестовины. Дальний силуэт референса. */
function latticeMast(p: Parts, cx: number, cz: number, height: number, halfBase: number) {
  const base = heightAt(cx, cz)
  const SEC = height / 10
  const legXZ = (i: number, y: number): [number, number] => {
    const k = 1 - (y / height) * 0.55 // сужается кверху
    const sx = i === 0 || i === 3 ? -1 : 1
    const sz = i < 2 ? -1 : 1
    return [cx + sx * halfBase * k, cz + sz * halfBase * k]
  }
  for (let i = 0; i < 4; i++) {
    for (let s = 0; s < 10; s++) {
      const y0 = s * SEC
      const y1 = y0 + SEC
      const [x0, z0] = legXZ(i, y0)
      const [x1, z1] = legXZ(i, y1)
      p.strut(0.075, x0, base + y0, z0, x1, base + y1, z1)
      // крестовина к следующей стойке
      const j = (i + 1) % 4
      const [x2, z2] = legXZ(j, y1)
      const [x3, z3] = legXZ(j, y0)
      p.strut(0.04, x0, base + y0, z0, x2, base + y1, z2)
      p.strut(0.04, x1, base + y1, z1, x3, base + y0, z3)
    }
  }
  return base + height
}

export function buildProps(): {
  group: THREE.Group
  /** То, что НЕ идёт в Octree: мелкая осыпь. Кладётся к рельефу, как лёд озера. */
  decor: THREE.Group
  spawn: THREE.Vector3
  yaw: number
  warm: Warm[]
  /** Отсветы на земле: до фазы 12 они были только у зданий. */
  spill: Warm[]
} {
  const group = new THREE.Group()
  group.name = 'props'

  const concrete = new Parts()
  const dark = new Parts()
  const metal = new Parts()
  const rocks = new Parts()
  const rocksDark = new Parts()
  const scree = new Parts()
  const snow = new Parts()
  const glow = new Parts()
  // Фонарь гостя светится сам — ему нужен свой материал (`MAT.lamp`), а не
  // красный `MAT.beacon` маячка на мачте.
  const lamp = new Parts()
  // Дерево и ржавчина у входа: ящики, поддон, черенок лопаты, вешки — и бочка
  // с катушкой. До фазы 13 всё это строилось из `dark`, то есть из бетона.
  const wood = new Parts()
  const rust = new Parts()
  // Следы на снегу: те же полупрозрачные накладки, что лужи и пятна грязи,
  // и живут они там же — в `decor`, мимо Octree.
  const tracks = new Parts()
  const rand = rng(20260724)
  const warm: Warm[] = []
  const spill: Warm[] = []

  const stair = stairProfile()

  // --- Дорожка --------------------------------------------------------------
  // Лента лежит на грунте и доводится до `stairProfile.join.foot` — точки
  // у кромки настила, куда раньше приходило подножие пандуса. Куда именно она
  // попадает — считает профиль, потому что это зависит от рельефа: дотянешь
  // руками — однажды между дорожкой и лестницей снова останется полметра пустоты.
  const line = resample([...PATH, [stair.join.foot.x, stair.join.foot.z] as const], 1.2)
  const path = new THREE.Mesh(ribbon(line, PATH_W), MAT.wet)
  path.name = 'path'
  group.add(path)

  // --- Лужи на дорожке -------------------------------------------------------
  // Самая заметная деталь референса после самой двери: мокрый бетон возвращает
  // оранжевый свет обратно в кадр. Лужа — не цвет, а ШЕРОХОВАТОСТЬ: пятно
  // roughness 0.07 ловит светящееся небо и фонари зеркалом, а лента вокруг
  // (roughness 0.5) рассеивает. Отдельной геометрией, потому что лента
  // процедурная и красить её по месту нечем.
  //
  // Пятна идут в `decor`, мимо Octree: плоскость на сантиметр над дорожкой,
  // попавшая в дерево коллизий, — это невидимая ступенька под ногами.
  const puddles = new THREE.Group()
  puddles.name = 'puddles'
  for (let i = 4; i < line.length - 4; i += 3) {
    if (rand() > 0.55) continue
    const [cx, cz] = line[i]
    // Смещение поперёк ленты: по центру ходят, вода стоит у кромок.
    const off = (rand() - 0.5) * PATH_W * 0.8
    const x = cx + off
    const z = cz + (rand() - 0.5) * 1.4
    const geo = new THREE.CircleGeometry(0.5 + rand() * 1.3, 12)
    geo.rotateX(-Math.PI / 2)
    geo.scale(1, 1, 0.55 + rand() * 0.5)
    const m = new THREE.Mesh(geo, MAT.puddle)
    m.position.set(x, heightAt(x, z) + 0.115, z)
    m.rotation.y = rand() * 3
    m.renderOrder = 1
    puddles.add(m)
  }

  // Пандуса с дорожки на марш здесь больше НЕТ — убран в сессии 8.
  // Плита 4.4×4.1 в `MAT.concrete` (0xb9c8ce — самый светлый материал мира),
  // задранная на 21° к камере, лежала белым квадратом ровно поперёк прохода:
  // ярче снега, ярче настила, единственное пятно кадра без пары на референсе.
  //
  // Проход при этом цел, и вот почему — число, из-за которого пандус казался
  // обязательным, меряет не то место. На оси поворота настил и правда на 1.72 м
  // выше грунта, но дорожка подходит к лестнице почти ВДОЛЬ неё и накрывает
  // настил нижнего марша за 5.5 м до поворота: там ступенька 0.29 при переступе
  // капсулы 0.30. Ниже по маршу нагорная кромка и вовсе врезана в скалу
  // (t=32 → 0.15, t=34 → −0.43). Входов на марш несколько, пандус был не входом,
  // а способом выйти сразу на площадку поворота.
  //
  // `checkStairs()` пункт 4 по-прежнему считает `rampRise`/`rampLen` и печатает
  // их в `npm run measure`: это числа стыка, они от геометрии не зависят.

  // --- Смотровая площадка ---------------------------------------------------
  const tTop = highestIn(TERRACE.x0, TERRACE.x1, TERRACE.z0, TERRACE.z1) + TERRACE.lift
  const tBottom = lowestIn(TERRACE.x0, TERRACE.x1, TERRACE.z0, TERRACE.z1) - 2
  dark.slab(TERRACE.x0, TERRACE.x1, TERRACE.z0, TERRACE.z1, tBottom, tTop - tBottom - 0.25)
  concrete.slab(TERRACE.x0, TERRACE.x1, TERRACE.z0, TERRACE.z1, tTop - 0.25, 0.25)

  // Марш с площадки вниз на дорожку. Проём — прямо перед точкой спавна,
  // чтобы взгляд уходил вниз по проходу, а не упирался в перила.
  const stepX = 2.5
  const foot = flightDownZ(metal, stepX, TERRACE.z0, tTop - 0.25, heightAt(stepX, 1) + 0.15, 2.4)
  concrete.slab(stepX - 1.4, stepX + 1.4, foot.z - 1.6, foot.z, foot.y - 0.3, 0.3)

  // перила площадки: левый борт и передний край, кроме проёма под марш
  railing(
    metal,
    [
      [TERRACE.x0, TERRACE.z1],
      [TERRACE.x0, TERRACE.z0],
      [stepX - 1.4, TERRACE.z0],
    ],
    () => tTop,
  )
  railing(
    metal,
    [
      [stepX + 1.4, TERRACE.z0],
      [TERRACE.x1, TERRACE.z0],
    ],
    () => tTop,
  )

  // --- Входная площадка комплекса -------------------------------------------
  // Ровная скала полки кончается там, где начинаются пятна зданий: с марша
  // игрок выходил в полосу шириной в полметра над обрывом. Плита
  // выносит площадку на кромку и даёт перед корпусами 6 м. Отметка берётся
  // из профиля марша — там она одна на плиту и на верхнюю ступень.
  {
    const top = stair.topY
    const bottom = lowestIn(APRON.x0, APRON.x1, APRON.z0, APRON.z1) - 2.5
    dark.slab(APRON.x0, APRON.x1, APRON.z0, APRON.z1, bottom, top - bottom - 0.25)

    // Верхняя площадка марша стоит на ТОЙ ЖЕ отметке, что плита, — так и надо,
    // с плиты на марш выходят без ступеньки. Но лежала она ПОВЕРХ плиты: две
    // грани вверх в одной плоскости давали зубчатую полосу поперёк выхода
    // (замер лучом: 21 точка на y=11.85). Плита поэтому кладётся с карманом
    // под неё — четырьмя кусками вокруг. Марш идёт под 18° к кромке, поэтому
    // карман считается по фактическому охвату площадки, а не по ширине марша:
    // повёрнутая коробка занимает по X больше собственной ширины.
    const land = stair.runs[0]
    const c = stair.at((land.t0 + land.t1) / 2)
    const halfLen = (land.t1 - land.t0) / 2
    const halfW = STAIR.width / 2
    const GAP = 0.03 // зазор кармана: заподлицо края снова начнут спорить
    const kx0 = Math.max(APRON.x0, c.x - halfLen * Math.abs(c.ux) - halfW * Math.abs(c.uz) - GAP)
    const kx1 = Math.min(APRON.x1, c.x + halfLen * Math.abs(c.ux) + halfW * Math.abs(c.uz) + GAP)
    const kz0 = Math.max(APRON.z0, c.z - halfLen * Math.abs(c.uz) - halfW * Math.abs(c.ux) - GAP)
    const kz1 = Math.min(APRON.z1, c.z + halfLen * Math.abs(c.uz) + halfW * Math.abs(c.ux) + GAP)
    const plate = (x0: number, x1: number, z0: number, z1: number) =>
      concrete.slab(x0, x1, z0, z1, top - 0.25, 0.25)
    if (kx1 <= kx0 || kz1 <= kz0) {
      plate(APRON.x0, APRON.x1, APRON.z0, APRON.z1)
    } else {
      plate(APRON.x0, APRON.x1, APRON.z0, kz0) // за карманом, вглубь площадки
      plate(APRON.x0, APRON.x1, kz1, APRON.z1) // перед ним (обычно пусто)
      plate(APRON.x0, kx0, kz0, kz1) // левее кармана
      plate(kx1, APRON.x1, kz0, kz1) // правее
    }

    // Перила по кромке площадки, кроме проёма под марш.
    const sx = STAIR.line[0][0]
    const rails: [number, number][] = []
    for (let x = APRON.x0 + 0.4; x <= APRON.x1 - 0.4; x += 1.7) {
      if (Math.abs(x - sx) < STAIR.width / 2 + 0.8) {
        if (rails.length) railing(metal, rails.splice(0), () => top)
        continue
      }
      rails.push([x, APRON.z1 - 0.3])
    }
    if (rails.length) railing(metal, rails, () => top)

    // И по левому торцу. Он появился в фазе 7 вместе с продлением плиты под
    // марш вестибюля: с этого края трёхметровая подпорная стенка, а идут туда
    // всегда — за низом того самого марша.
    railing(
      metal,
      [
        [APRON.x0 + 0.35, APRON.z1 - 0.3],
        [APRON.x0 + 0.35, APRON.z0 + 0.4],
      ],
      () => top,
    )
  }

  // --- Перила вдоль дорожки, по краю обрыва --------------------------------
  //
  // ПРОЁМ У СТЫКА С ЛЕСТНИЦЕЙ ОБЯЗАТЕЛЕН. Перила идут по обрывной стороне, а
  // сход на марш начинается ровно там же — доведённые до конца, они отгораживают
  // лестницу от дорожки глухой стенкой. В кадре этого не видно (тонкие трубы
  // в тумане), а пешком до лестницы дойти нельзя: автопроход упирался в
  // невидимую преграду и стоял там до конца теста (фаза 3.5).
  //
  // Проём привязан к поворотной площадке, а не к верху марша: в фазе 3.6 верх
  // уехал на полку за 30 м отсюда, проём уехал вместе с ним, и стык снова
  // оказался заперт — на этот раз никто не заметил, потому что до лестницы
  // всё равно нельзя было дойти по другой причине.
  const GAP = 6.5
  const edge: [number, number][] = []
  for (let i = 0; i < line.length; i += 2) {
    const [x, z] = line[i]
    if (Math.hypot(x - stair.join.x, z - stair.join.z) < GAP) continue
    const [ax, az] = line[Math.max(0, i - 1)]
    const [bx, bz] = line[Math.min(line.length - 1, i + 1)]
    let dx = bx - ax
    let dz = bz - az
    const l = Math.hypot(dx, dz) || 1
    edge.push([x + (dz / l) * (PATH_W / 2 + 0.35), z - (dx / l) * (PATH_W / 2 + 0.35)])
  }
  railing(metal, edge, (x, z) => heightAt(x, z) + 0.12)

  // --- Вешки вдоль дорожки ---------------------------------------------------
  // На референсе вдоль прохода торчит ряд тонких реек с тёмными верхушками.
  // Ставятся слева от ленты — а слева у стыка лежит настил лестницы, поэтому
  // у поворотной площадки вешки прекращаются: иначе две рейки вырастают прямо
  // посреди марша. Ровно это и вылезло, когда лента дотянулась до лестницы.
  for (let i = 3; i < line.length - 3; i += 5) {
    const [x, z] = line[i]
    if (Math.hypot(x - stair.join.x, z - stair.join.z) < STAIR.width + 3) continue
    const px = x - PATH_W / 2 - 0.7
    wood.pipe(0.035, 1.9, px, heightAt(px, z), z, 4)
    dark.pipe(0.05, 0.32, px, heightAt(px, z) + 1.9, z, 4)
  }

  // --- Вещи у входа ----------------------------------------------------------
  // На кадре до фазы 6 не было НИ ОДНОГО предмета, принесённого человеком:
  // здания, скала, снег — и ни лопаты, ни ящика. Именно они, а не количество
  // полигонов на стене, отличают обитаемую станцию от макета.
  //
  // Всё стоит вплотную к фасаду: дорожка — коридор, на нём не стоит ничего.
  // Отметка каждой вещи берётся по `heightAt`, иначе она утонет в снегу
  // или повиснет над ним (первая же строка «Открытых проблем» журнала).
  {
    const wx = WING[1].x0 - 0.55 // полметра от стены: не задевает обвязку фасада
    const g = (z: number) => heightAt(wx, z)

    // Штабель ящиков у стены, слегка вразнобой.
    for (const [dz, w, h, d, yaw] of [
      [-8.4, 0.8, 0.5, 0.62, 0.12],
      [-8.3, 0.74, 0.46, 0.58, -0.2],
      [-7.6, 0.66, 0.44, 0.5, 0.35],
    ] as const) {
      const base = g(dz) + (dz === -8.3 ? 0.5 : 0)
      wood.boxOn(w, h, d, wx, base, dz, yaw)
      metal.boxOn(w * 0.96, 0.04, d * 0.96, wx, base + h, dz, yaw)
    }

    // Бочка. Обод сверху и снежная шапка — без них цилиндр читается тумбой.
    {
      const z = -9.6
      const base = g(z)
      rust.pipe(0.29, 0.88, wx + 0.1, base, z, 12)
      metal.pipe(0.31, 0.05, wx + 0.1, base + 0.82, z, 12)
      metal.pipe(0.31, 0.05, wx + 0.1, base + 0.4, z, 12)
    }

    // Поддон, прислонённый к стене: доски под наклоном. Наклон запечён в
    // геометрию — через параметры `add` он уехал бы вокруг мировой оси.
    {
      const z = -2.2
      const base = g(z)
      for (let k = 0; k < 5; k++) {
        const board = new THREE.BoxGeometry(0.09, 1.15, 0.14)
        board.rotateZ(0.26)
        wood.add(board, wx + 0.12, base + 0.58, z - 0.3 + k * 0.16)
      }
      wood.box(0.1, 0.1, 0.82, wx + 0.02, base + 0.95, z)
    }

    // Ящик с песком у двери — с покатой крышкой, чтобы не путался с ящиками.
    {
      const z = -3.4
      const base = g(z)
      wood.boxOn(0.72, 0.55, 1.05, wx, base, z)
      const lid = new THREE.BoxGeometry(0.78, 0.07, 1.1)
      lid.rotateZ(0.1)
      metal.add(lid, wx, base + 0.58, z)
    }

    // Лопата у стены: черенок под углом и полотно у земли.
    {
      const z = -6.35
      const base = g(z)
      const shaft = new THREE.CylinderGeometry(0.028, 0.028, 1.5, 6)
      shaft.rotateZ(0.22)
      wood.add(shaft, wx + 0.16, base + 0.78, z)
      const blade = new THREE.BoxGeometry(0.06, 0.34, 0.26)
      blade.rotateZ(0.22)
      metal.add(blade, wx + 0.34, base + 0.15, z)
    }

    // Катушка кабеля: две щеки и барабан между ними.
    {
      const z = -11.4
      const base = g(z)
      const R = 0.44
      for (const dz of [-0.26, 0.26]) {
        const cheek = new THREE.CylinderGeometry(R, R, 0.06, 14)
        cheek.rotateX(Math.PI / 2)
        wood.add(cheek, wx + 0.2, base + R, z + dz)
      }
      const drum = new THREE.CylinderGeometry(0.22, 0.22, 0.5, 12)
      drum.rotateX(Math.PI / 2)
      rust.add(drum, wx + 0.2, base + R, z)
    }

    // --- Фонарь, оставленный у порога ----------------------------------------
    // Вся история станции держится на этом предмете. Людей нет давно: окна
    // тёмные, лампы погашены, снег у дверей не топтан годами. Но кто-то был
    // здесь несколько часов назад — растопил печь в дежурке (`furnish.ts`)
    // и оставил у входа переносной фонарь. Одна вещь на своём месте говорит
    // «здесь сейчас кто-то есть» сильнее, чем любая надпись.
    //
    // Стоит НЕ на дорожке, а у фасада, рядом с ящиком: правило коридора
    // действует и на вещи гостя.
    {
      // Отступ 1.75 от фасада, а не 0.75: крыльцо (`threshold` в buildings)
      // уводит ступени от стены на 1.7 м, и фонарь, поставленный ближе,
      // оказывался вмурован в нижнюю ступень (видно только в кадре у порога).
      const lz = WING_PLAN.entry.z + 0.1
      const lx = wx - 1.75
      const base = heightAt(lx, lz)
      metal.pipe(0.105, 0.06, lx, base, lz, 10) // донце
      lamp.pipe(0.075, 0.17, lx, base + 0.06, lz, 10) // стекло
      metal.pipe(0.1, 0.05, lx, base + 0.23, lz, 10) // крышка
      // Дужка: две наклонные стойки, сходящиеся над крышкой.
      for (const s of [-1, 1]) {
        metal.strut(0.012, lx + s * 0.085, base + 0.26, lz, lx, base + 0.4, lz, 4)
      }
      const li = new THREE.PointLight(0xffb066, 3.2, 6, 2)
      li.position.set(lx, base + 0.2, lz)
      group.add(li)
      warm.push({
        pos: new THREE.Vector3(lx, base + 0.15, lz),
        color: 0xffb066,
        size: 0.75,
        power: 0.5,
        label: 'фонарь у порога',
      })
      spill.push({
        pos: new THREE.Vector3(lx - 0.2, base + 0.06, lz),
        color: 0xffb066,
        size: 1.7,
        power: 0.32,
        label: 'пятно от фонаря',
      })
    }

    // --- Следы от дорожки к двери --------------------------------------------
    // Снег у станции не топтан — кроме одной цепочки: гость прошёл с дорожки
    // к порогу, и это единственное движение, оставшееся в кадре после того,
    // как людей убрали. Следы идут ПО СНЕГУ, а не по ленте: на мокром бетоне
    // тёмное пятно не читается, а на белом видно за двадцать метров.
    {
      const fromX = 5.2
      const toX = wx - 1.6
      const fromZ = WING_PLAN.entry.z - 2.6
      const toZ = WING_PLAN.entry.z + 0.35
      const N = 12
      for (let i = 0; i <= N; i++) {
        const t = i / N
        // Шаг вразнобой по сторонам: цепочка одинаковых пятен по линейке
        // читается пунктиром, а не следами (урок подтёков фазы 6).
        const side = (i % 2 ? 1 : -1) * 0.13
        const x = fromX + (toX - fromX) * t + side * 0.6
        const z = fromZ + (toZ - fromZ) * t + side
        const step = new THREE.PlaneGeometry(0.3 + rand() * 0.08, 0.4 + rand() * 0.1)
        // Подъём 0.18, а не 2 см: снег в этом мире не геометрия, а СЛОЙ
        // в шейдере, и он поднимает поверхность рельефа на `SNOW.thickness`
        // (0.1) с шумом до 0.155. Первая версия следов легла на голый рельеф —
        // то есть под снег, и в кадре их не было вовсе.
        tracks.add(keepUV(step), x, heightAt(x, z) + 0.18, z, -Math.PI / 2, rand() * 0.5 - 0.25, 0)
      }
    }

    // Вешки-палки у стены, связкой: их ставят на дорожку, когда заметает.
    for (let k = 0; k < 4; k++) {
      const z = -12.6 - k * 0.06
      const stick = new THREE.CylinderGeometry(0.022, 0.022, 1.8, 5)
      stick.rotateZ(0.14 + k * 0.03)
      wood.add(stick, wx + 0.18 + k * 0.05, heightAt(wx, z) + 0.88, z)
    }

    // Снежные наносы вдоль фасада. На референсе снег у стен лежит валиками:
    // его туда сгребают с прохода, и именно эти валики отделяют дорожку от
    // здания. Идут в `decor` — это форма, а не препятствие: наносом высотой
    // по колено капсула и так проходит, а в Octree он даёт липкую кромку.
    for (let z = WING[1].z0 + 1; z < WING[1].z1 - 1; z += 2.2) {
      const len = 1.6 + rand() * 1.4
      const w = 0.5 + rand() * 0.5
      const drift = new THREE.SphereGeometry(1, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2)
      drift.scale(w, 0.24 + rand() * 0.18, len / 2)
      snow.add(drift, wx + 0.75, heightAt(wx + 0.75, z) - 0.05, z + rand() * 0.6, 0, rand() * 0.4, 0)
    }
  }

  // --- Короба вентиляции и антенны на крышах --------------------------------
  // Пятна берутся из layout.ts. Раньше здесь лежала копия WING, и сдвиг здания
  // оставлял короба с антеннами висеть в воздухе на старом месте.
  const roofGear = (
    x0: number,
    x1: number,
    z0: number,
    z1: number,
    top: number,
    boxes: number,
    masts: number,
  ) => {
    // Занятые пятна: короба ставятся случайно, и без отбора двое садятся на
    // одно место. Стоят они ВСЕ низом на крыше, поэтому у налезших друг на
    // друга низ оказывается в одной плоскости и смотрит в одну сторону —
    // полосы под коробом (3.4 м² на крыше второй секции). Плюс короб в коробе
    // и сам по себе выглядит поломкой. Попыток немного: не нашли места за
    // восемь — пропускаем короб, крыша не обеднеет.
    const taken: [number, number, number, number][] = []
    const free = (x: number, z: number, w: number, d: number) =>
      !taken.some(
        ([ax0, az0, ax1, az1]) =>
          x - w / 2 < ax1 + 0.1 && x + w / 2 > ax0 - 0.1 && z - d / 2 < az1 + 0.1 && z + d / 2 > az0 - 0.1,
      )
    for (let k = 0; k < boxes; k++) {
      const w = 0.9 + rand() * 1.8
      const h = 0.7 + rand() * 1.1
      const d = w * (0.6 + rand() * 0.9)
      let x = 0
      let z = 0
      let ok = false
      for (let t = 0; t < 8 && !ok; t++) {
        x = x0 + 2.5 + rand() * (x1 - x0 - 5)
        z = z0 + 2.5 + rand() * (z1 - z0 - 5)
        ok = free(x, z, w, d)
      }
      if (!ok) continue
      taken.push([x - w / 2, z - d / 2, x + w / 2, z + d / 2])
      // Снег на коробе кладёт шейдерный слой: на референсе крыши читаются
      // рядом белых пятен на тёмных ящиках, и слой даёт их сам — с рваным
      // краем и переходом на стенку короба, чего плита не умела.
      dark.boxOn(w, h, d, x, top, z)
    }
    // штыревые антенны разной длины — очень характерный силуэт референса
    for (let k = 0; k < masts; k++) {
      const x = x0 + 1.5 + rand() * (x1 - x0 - 3)
      const z = z0 + 1.5 + rand() * (z1 - z0 - 3)
      metal.pipe(0.05, 4 + rand() * 8, x, top, z, 4)
    }
  }

  for (const r of WING) {
    roofGear(r.x0, r.x1, r.z0, r.z1, floorOf(r) + r.h + 0.16, 4, 5)
  }
  // Крыша центрального корпуса — верхний, ступенчатый объём (см. buildings.ts).
  roofGear(CORE.x0 + 2.5, CORE.x1 - 2.5, CORE.z0 + 3, CORE.z1 - 2, floorOf(CORE) + CORE.h + 3.2 + 0.16, 2, 4)

  // --- Решётчатая мачта с габаритным огнём ----------------------------------
  // Позади и правее центрального корпуса, отдельно стоящая. До фазы 3.5 стояла
  // ВНУТРИ его пятна: сквозь стену торчала решётка, и никто этого не видел,
  // потому что в коде мачта и корпус лежали в разных файлах.
  {
    const { x, z, h, halfBase } = LATTICE
    const topY = latticeMast(metal, x, z, h, halfBase)

    // Оттяжки на три стороны и кабель, уходящий с мачты на крышу корпуса.
    // Крепятся на две трети высоты — как настоящие, и как на референсе, где
    // тросы видно раньше самой решётки.
    //
    // Куда они сходят на землю — считает `guyAnchors()` в `layout.ts`: это
    // расстановка, и проверка обязана читать те же числа (см. комментарий там).
    const anchor = topY - h * 0.32
    for (const [ax, az] of guyAnchors()) {
      sag(metal, x, anchor, z, ax, heightAt(ax, az) + 0.2, az, 0.45, 6, 0.022)
      // Анкер в земле: без него трос уходит в грунт ниоткуда.
      dark.boxOn(0.3, 0.35, 0.3, ax, heightAt(ax, az) - 0.1, az)
    }
    // Кабель на крышу центрального корпуса — связывает мачту со станцией.
    sag(
      metal,
      x,
      anchor - 1.5,
      z,
      CORE.x1 - 1.5,
      floorOf(CORE) + CORE.h + 0.4,
      (CORE.z0 + CORE.z1) / 2,
      1.1,
      8,
      0.025,
    )
    glow.add(new THREE.SphereGeometry(0.34, 10, 8), x, topY + 0.5, z)
    const l = new THREE.PointLight(0xff2a18, 4, 12, 2)
    l.position.set(x, topY + 0.5, z)
    group.add(l)
    // Единственное красное пятно кадра, и оно должно пробиваться сквозь туман:
    // на референсе огонь на мачте виден, когда сама мачта уже еле читается.
    warm.push({
      pos: new THREE.Vector3(x, topY + 0.5, z),
      color: 0xff3a22,
      size: 2.2,
      power: 0.9,
      label: 'габаритный огонь',
    })
  }

  // --- Тонкие мачты дальнего плана ------------------------------------------
  for (const [x, z, h] of THIN_MASTS) {
    metal.pipe(0.09, h, x, heightAt(x, z), z, 5)
  }

  // --- Осыпь на склоне -------------------------------------------------------
  // Скальный борт без камней читается как мятая простыня. До фазы 6 камней было
  // 160 штук калибра 0.35–1.45 на шесть тысяч квадратных метров — один камень
  // на сорок метров, то есть в кадре их не было видно вовсе.
  //
  // Три калибра, и это не украшательство: масштаб склону задаёт именно
  // соотношение размеров. Одинаковые камни читаются гравием под ногами
  // независимо от того, какого они размера на самом деле.
  //
  // Отбор строго по крутизне: по высоте отсеивать нельзя — дорожка вдали
  // опускается ниже бровки, и валуны высыпаются прямо на проход.
  const CALIBERS = [
    // Крупным валунам нужен `detail: 1`: у голого икосаэдра грань размером
    // с сам камень, и повёрнутая к глазу она читается плоским многоугольником,
    // а не камнем — в 19 метрах от камеры это выглядело синей заплатой
    // (`reference/shots/phase6_boulder_slab.png`).
    { n: 90, min: 1.1, max: 2.4, slope: 0.36, dark: 0.35, scree: false, detail: 1 },
    { n: 260, min: 0.45, max: 1.1, slope: 0.34, dark: 0.45, scree: false, detail: 0 },
    // Мелочь идёт МИМО Octree (`decor`, не `group`): 400 камешков высотой
    // с переступ капсулы превращают склон в липучку, по которой не пройти,
    // а в кадре они работают одной только рябью.
    { n: 420, min: 0.14, max: 0.45, slope: 0.3, dark: 0.5, scree: true, detail: 0 },
  ]
  for (const cal of CALIBERS) {
    for (let i = 0; i < cal.n; i++) {
      const x = -55 + rand() * 63
      const z = -78 + rand() * 100
      if (slopeAt(x, z) < cal.slope) continue // 0.45 ≈ 24°: борт, не плато
      // Дорожка — коридор, на нём не стоит ничего (правило `layout.ts`).
      let onPath = false
      for (const [px, pz] of line) {
        if (Math.hypot(x - px, z - pz) < CORRIDOR) {
          onPath = true
          break
        }
      }
      if (onPath) continue
      const s = cal.min + rand() * (cal.max - cal.min)
      // Камень не шар: сплющиваем по высоте и вытягиваем по случайной оси.
      // Масштаб запекается в геометрию — `Parts.add` собирает Эйлера XYZ,
      // и наклон через параметры уехал бы вокруг мировой оси (правило фазы 4).
      const geo = new THREE.IcosahedronGeometry(s, cal.detail)
      geo.scale(1 + rand() * 0.5, 0.62 + rand() * 0.3, 1 + rand() * 0.4)
      const target = cal.scree ? scree : rand() < cal.dark ? rocksDark : rocks
      const y = heightAt(x, z) + s * 0.18
      // Крутится камень в основном вокруг вертикали, заваливаясь лишь слегка:
      // сплющенный по высоте булыжник, кувыркнутый на произвольный угол,
      // встаёт торчком и перестаёт быть камнем.
      target.add(geo, x, y, z, (rand() - 0.5) * 0.6, rand() * 6.3, (rand() - 0.5) * 0.6)
      // Нашлёпки на макушках больше нет: снег на камне — тот же шейдерный
      // слой, что на бетоне (`snowify`), и он ложится по настоящей форме
      // валуна, а не отдельным сплющенным икосаэдром поверх него.
    }
  }

  group.add(
    concrete.mesh(MAT.concrete, 'prop-concrete'),
    dark.mesh(MAT.concreteDark, 'prop-dark'),
    metal.mesh(MAT.metal, 'prop-metal'),
    rocks.mesh(MAT.rock, 'boulders'),
    rocksDark.mesh(MAT.rockDark, 'boulders-dark'),
    glow.mesh(MAT.beacon, 'beacon'),
    lamp.mesh(MAT.lamp, 'lantern'),
    wood.mesh(MAT.wood, 'prop-wood'),
    rust.mesh(MAT.rust, 'prop-rust'),
  )

  // Всё, чего не должно быть в Octree: щебень мелок настолько, что как
  // препятствие он только мешает, а как деталь работает и без коллизии.
  const decor = new THREE.Group()
  decor.name = 'decor'
  decor.add(
    scree.mesh(MAT.rockDark, 'scree'),
    snow.mesh(MAT.snow, 'prop-snow'),
    tracks.mesh(MAT.stain, 'tracks'),
    puddles,
  )

  // Спавн — на переднем краю площадки. yaw 0 = взгляд в -Z; довернуто влево,
  // чтобы кадр делился как на референсе: корпус справа, скала слева.
  const spawn = new THREE.Vector3(2.5, tTop + 0.1, 8.4)
  return { group, decor, spawn, yaw: 0.14, warm, spill }
}
