/**
 * tools/room.ts — карта помещения на Node, без браузера.
 *
 *     npm run room            все помещения
 *     npm run room -- дежур   только те, чьё имя содержит подстроку
 *     npm run room -- --list  одна строка на помещение, без планов
 *
 * Зачем. Интерьер — единственная часть мира, которую не видно ни в кадре
 * (он внутри), ни в коде (там `metal.boxOn(0.62, 1.95, 0.55, x1 - 0.42, …)`).
 * Проверять его ходили в браузер: скриншот, автопроход, снова скриншот. Дорого
 * и не каждый раз — поэтому полка, перегородившая выход из дежурки, прожила
 * целую сессию, а пять препятствий подряд в фазе 5 нашлись только ногами.
 *
 * Здесь берутся НАСТОЯЩИЕ модули мира: `buildBuildings()` собирает те же
 * коробки, что уйдут в кадр, реестр `fixtures.ts` снимает с них габариты,
 * а `Interiors` даёт границы комнат. Копий чисел нет ни одной — это то же
 * правило, по которому живёт `npm run measure`.
 *
 * Что печатается:
 *   1. шапка комнаты: отметки пола и потолка, размеры;
 *   2. план видом сверху — по клеткам, с легендой;
 *   3. второй план «под потолком», если там что-то висит;
 *   4. таблица предметов с габаритами;
 *   5. претензии: перекрытия, створ двери, зазоры, проход.
 *
 * Чего он НЕ заменяет: вид. Красиво ли — решает кадр, и для этого браузер
 * по-прежнему нужен. Инструмент отвечает на другой вопрос — стоит ли предмет
 * там, где задумано, и можно ли пройти.
 */

import { buildBuildings } from '../src/world/buildings'
import { FIXTURES, type Fixture, type Kind } from '../src/world/fixtures'
import { inRound, type Room } from '../src/world/interior'

// --- Размеры игрока: всё, что ниже, взято из player.ts ------------------------
/** Радиус капсулы. Проход шириной меньше двух радиусов непроходим. */
const R = 0.34
/** Переступ: ящик ниже этого игрок перешагивает, не замечая (см. check.ts). */
const STEP = 0.3
/** Верх капсулы над полом: 1.68 глаза + радиус. Ниже этого висеть нельзя. */
const HEAD = 2.02

/** Клетка плана. По Z вдвое крупнее: знак в терминале вдвое выше своей ширины. */
const CELL_X = 0.25
const CELL_Z = 0.5

const argv = process.argv.slice(2)
const listOnly = argv.includes('--list')
const filter = argv.filter((a) => !a.startsWith('--')).join(' ').toLowerCase()

const f2 = (v: number) => (v < 0 ? '' : ' ') + v.toFixed(2)

// --- Сборка мира --------------------------------------------------------------
const built = buildBuildings()
const rooms = built.interiors.rooms

/**
 * Комната предмета: та, в чей объём попал ЦЕНТР его габарита.
 *
 * Запас 0.45 м — толщина стены плюс немного: окна, косяки и трубы сидят
 * в самой стене, снаружи полезного объёма, и без запаса выпали бы из карты
 * той комнаты, которой принадлежат. Если подходит несколько, берётся та,
 * внутри которой центр лежит глубже.
 *
 * Глубина считается ПО ТРЁМ осям, и это не педантизм. Вестибюль обсерватории
 * и зал над ним стоят друг на друге и в плане совпадают: по XZ телескоп с
 * пультом лежат внутри обоих, а вестибюль ещё и шире — на первом запуске
 * инструмент честно приписал ему всю обстановку зала и выдал шесть претензий
 * «предмет выше потолка». Высота разводит их сразу.
 */
const PAD = 0.45

function roomOf(f: Fixture): Room | null {
  const cx = (f.x0 + f.x1) / 2
  const cy = (f.y0 + f.y1) / 2
  const cz = (f.z0 + f.z1) / 2
  let best: Room | null = null
  let bestDepth = -Infinity
  for (const r of rooms) {
    const d = Math.min(
      cx - (r.x0 - PAD),
      r.x1 + PAD - cx,
      cz - (r.z0 - PAD),
      r.z1 + PAD - cz,
      cy - (r.y0 - 0.2),
      r.y1 + 0.2 - cy,
    )
    if (d > 0 && d > bestDepth) {
      bestDepth = d
      best = r
    }
  }
  return best
}

const byRoom = new Map<string, Fixture[]>()
for (const f of FIXTURES) {
  const r = roomOf(f)
  if (!r) continue
  const list = byRoom.get(r.name) ?? []
  list.push(f)
  byRoom.set(r.name, list)
}

/**
 * Мешает ли предмет пройти.
 *
 * Не «занимает ли объём», а именно мешает: по маршу ходят, сквозь стекло
 * смотрят, под трубой у потолка проходят, а ящик ниже переступа перешагивают.
 * Ровно из-за этой разницы проверка «предметы не пересекаются» ничего не
 * говорит о проходимости, и наоборот.
 */
function blocks(f: Fixture, floor: number): boolean {
  if (f.kind === 'glass' || f.kind === 'door' || f.kind === 'light' || f.kind === 'stair') return false
  return f.y1 > floor + STEP && f.y0 < floor + HEAD - 0.15
}

/** Сетка проходимости комнаты: true — сюда центр капсулы встать не может. */
function grid(room: Room, items: Fixture[], cx: number) {
  const nx = Math.max(1, Math.round((room.x1 - room.x0) / cx))
  const nz = Math.max(1, Math.round((room.z1 - room.z0) / CELL_Z))
  const busy = new Uint8Array(nx * nz)
  const at = (ix: number, iz: number) => room.x0 + (ix + 0.5) * cx
  const az = (ix: number, iz: number) => room.z0 + (iz + 0.5) * CELL_Z
  // Клетки, куда капсула встала бы в ПУСТОЙ комнате. Это и есть знаменатель
  // «свободного пола»: доля от всех клеток рамки мерила бы заодно толщину
  // стен, а у круглого зала — ещё и четверть площади за барабаном.
  let usable = 0

  for (let iz = 0; iz < nz; iz++) {
    for (let ix = 0; ix < nx; ix++) {
      const x = at(ix, iz)
      const z = az(ix, iz)
      // Стены: капсула не встанет ближе своего радиуса к границе объёма.
      // У круглого помещения граница — окружность, и рамка тогда описанный
      // квадрат: без этой проверки четверть «свободного пола» зала лежала бы
      // за барабаном.
      let bad =
        x - room.x0 < R ||
        room.x1 - x < R ||
        z - room.z0 < R ||
        room.z1 - z < R ||
        !inRound(room, x, z, R)
      if (!bad) {
        usable++
        for (const f of items) {
          if (!blocks(f, room.y0 + 0.5)) continue
          // Габарит расширен на радиус капсулы — это и есть учёт её толщины.
          if (x > f.x0 - R && x < f.x1 + R && z > f.z0 - R && z < f.z1 + R) {
            bad = true
            break
          }
        }
      }
      busy[iz * nx + ix] = bad ? 1 : 0
    }
  }
  return { nx, nz, busy, at, az, cx, usable }
}

/** Связная область свободных клеток от заданной. Возвращает маску достижимого. */
function flood(g: ReturnType<typeof grid>, from: number): Uint8Array {
  const seen = new Uint8Array(g.nx * g.nz)
  if (g.busy[from]) return seen
  const q = [from]
  seen[from] = 1
  while (q.length) {
    const i = q.pop()!
    const ix = i % g.nx
    const iz = (i / g.nx) | 0
    const push = (jx: number, jz: number) => {
      if (jx < 0 || jz < 0 || jx >= g.nx || jz >= g.nz) return
      const j = jz * g.nx + jx
      if (seen[j] || g.busy[j]) return
      seen[j] = 1
      q.push(j)
    }
    push(ix - 1, iz)
    push(ix + 1, iz)
    push(ix, iz - 1)
    push(ix, iz + 1)
  }
  return seen
}

/** Есть ли под предметом хоть одна клетка, куда игрок может встать. */
function overFreeFloor(g: ReturnType<typeof grid>, room: Room, f: Fixture): boolean {
  for (let iz = 0; iz < g.nz; iz++) {
    for (let ix = 0; ix < g.nx; ix++) {
      if (g.busy[iz * g.nx + ix]) continue
      const x = g.at(ix, iz)
      const z = g.az(ix, iz)
      if (x > f.x0 - R && x < f.x1 + R && z > f.z0 - R && z < f.z1 + R) return true
    }
  }
  return false
}

/** Ближайшая свободная клетка к точке — точка входа заливки от двери. */
function nearestFree(g: ReturnType<typeof grid>, room: Room, x: number, z: number): number {
  let best = -1
  let bestD = Infinity
  for (let iz = 0; iz < g.nz; iz++) {
    for (let ix = 0; ix < g.nx; ix++) {
      const i = iz * g.nx + ix
      if (g.busy[i]) continue
      const d = Math.hypot(g.at(ix, iz) - x, g.az(ix, iz) - z)
      if (d < bestD) {
        bestD = d
        best = i
      }
    }
  }
  return bestD < 2.5 ? best : -1
}

// --- Символы плана ------------------------------------------------------------
const ALPHABET = 'ABCDEFGHKLMNPQRSTUVWXYZ'
/** Приоритет: чем важнее предмет, тем он выигрывает клетку у соседа. */
const RANK: Record<Kind, number> = {
  door: 9,
  stair: 8,
  furn: 7,
  small: 6,
  hang: 5,
  glass: 4,
  light: 3,
  wall: 2,
}

function planOf(room: Room, items: Fixture[], lo: number, hi: number, cx: number): string[] {
  const nx = Math.max(1, Math.round((room.x1 - room.x0) / cx))
  const nz = Math.max(1, Math.round((room.z1 - room.z0) / CELL_Z))
  const shown = items.filter((f) => f.y1 > lo && f.y0 < hi)
  const sym = new Map<string, string>()
  for (const f of shown) {
    if (!sym.has(f.name)) sym.set(f.name, ALPHABET[sym.size % ALPHABET.length])
  }
  const cells = new Array<string>(nx * nz).fill('·')
  const rank = new Int8Array(nx * nz)
  // За круглой стеной пола нет вовсе: у зала обсерватории рамка — описанный
  // квадрат, и без этого план врал бы на четверть площади.
  for (let iz = 0; iz < nz; iz++)
    for (let ix = 0; ix < nx; ix++) {
      const x = room.x0 + (ix + 0.5) * cx
      const z = room.z0 + (iz + 0.5) * CELL_Z
      if (!inRound(room, x, z)) cells[iz * nx + ix] = ' '
    }
  for (const f of shown) {
    const s = sym.get(f.name)!
    const ix0 = Math.max(0, Math.floor((f.x0 - room.x0) / cx))
    const ix1 = Math.min(nx - 1, Math.floor((f.x1 - room.x0) / cx))
    const iz0 = Math.max(0, Math.floor((f.z0 - room.z0) / CELL_Z))
    const iz1 = Math.min(nz - 1, Math.floor((f.z1 - room.z0) / CELL_Z))
    for (let iz = iz0; iz <= iz1; iz++) {
      for (let ix = ix0; ix <= ix1; ix++) {
        const i = iz * nx + ix
        if (RANK[f.kind] >= rank[i]) {
          rank[i] = RANK[f.kind]
          cells[i] = s
        }
      }
    }
  }
  const out: string[] = []
  const bar = '─'.repeat(nx)
  out.push(`      ┌${bar}┐  z ${f2(room.z0)}`)
  for (let iz = 0; iz < nz; iz++) {
    let row = ''
    for (let ix = 0; ix < nx; ix++) row += cells[iz * nx + ix]
    out.push(`      │${row}│`)
  }
  out.push(`      └${bar}┘  z ${f2(room.z1)}`)
  out.push(`      x ${f2(room.x0)} → ${f2(room.x1)}, клетка ${cx} × ${CELL_Z} м`)
  const legend = [...sym].map(([n, s]) => `${s} ${n}`).join('   ')
  if (legend) out.push('      ' + legend)
  return out
}

// --- Претензии ----------------------------------------------------------------
function complaints(
  room: Room,
  items: Fixture[],
  g: ReturnType<typeof grid>,
): { bad: string[]; look: string[] } {
  const bad: string[] = []
  /** Не ошибка, но и не наверняка: пары, которые стоит глянуть в кадре. */
  const look: string[] = []
  const floor = room.y0 + 0.5 // объём регистрируется на 0.5 ниже пола
  const inner = items.filter((f) => f.kind !== 'door' && f.kind !== 'glass')

  // 1. Пересечения. Не всякое пересечение — ошибка (плафон в трубе, ящик на
  //    полке), поэтому порог 6 см и только между тем, что стоит и висит.
  const solid = inner.filter((f) => f.kind === 'furn' || f.kind === 'small' || f.kind === 'hang')
  for (let i = 0; i < solid.length; i++) {
    for (let j = i + 1; j < solid.length; j++) {
      const a = solid[i]
      const b = solid[j]
      const ox = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0)
      const oy = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0)
      const oz = Math.min(a.z1, b.z1) - Math.max(a.z0, b.z0)
      // Ящик под столом и сапоги под скамьёй — не ошибка, а нормальный способ
      // хранения, но по габаритам они внутри: рамка стола накрывает всю пустоту
      // между ножками. Считаем спором только то, что торчит ВЫШЕ верха большого
      // предмета, — то есть действительно стоит в нём, а не под ним.
      const tucked =
        (a.kind === 'small' && a.y1 <= b.y1 + 0.02) || (b.kind === 'small' && b.y1 <= a.y1 + 0.02)
      if (ox <= 0.06 || oy <= 0.06 || oz <= 0.06) continue
      if (!tucked) {
        bad.push(
          `«${a.name}» и «${b.name}» в одном месте: перекрытие ${ox.toFixed(2)}×${oy.toFixed(2)}×${oz.toFixed(2)} м`,
        )
        continue
      }
      // Задвинутое под мебель проверка пропускает — и пропускает вместе с ним
      // предмет, наполовину вошедший в чужой бок. Полено, торчащее из ящика
      // с углём, ниже его крышки, то есть формально «под» ним; нашлось оно
      // глазами в кадре, а не здесь. Отличить одно от другого габаритами
      // нельзя: мешок в контейнере и сапоги под скамьёй выглядят так же.
      // Поэтому такие пары не претензия, а отдельный список на глаз: сюда
      // попадает то, что НЕ накрыто большим предметом в плане целиком.
      const covered = (s: Fixture, big: Fixture) =>
        s.x0 >= big.x0 - 0.02 && s.x1 <= big.x1 + 0.02 && s.z0 >= big.z0 - 0.02 && s.z1 <= big.z1 + 0.02
      if (!covered(a, b) && !covered(b, a)) {
        look.push(
          `«${a.name}» наполовину в «${b.name}»: перекрытие ${ox.toFixed(2)}×${oy.toFixed(2)}×${oz.toFixed(2)} м`,
        )
      }
    }
  }

  // 2. Торчит сквозь стену или потолок. Окна и косяки в стене — по определению,
  //    их здесь нет (отфильтрованы выше).
  for (const f of inner) {
    const out = Math.max(room.x0 - f.x0, f.x1 - room.x1, room.z0 - f.z0, f.z1 - room.z1)
    if (out > 0.05) bad.push(`«${f.name}» уходит в стену на ${out.toFixed(2)} м`)
    // Круглая стена: мерить надо по ДАЛЬНЕМУ УГЛУ рамки, а не по её центру.
    // У предмета, поставленного по касательной к барабану, центр остаётся
    // внутри радиуса, когда угол уже в бетоне, — и рамочная проверка выше
    // на круглом зале не срабатывает вовсе.
    if (room.r !== undefined) {
      const cx = (room.x0 + room.x1) / 2
      const cz = (room.z0 + room.z1) / 2
      let far = 0
      for (const qx of [f.x0, f.x1])
        for (const qz of [f.z0, f.z1]) far = Math.max(far, Math.hypot(qx - cx, qz - cz))
      if (far > room.r + 0.05) {
        bad.push(`«${f.name}» уходит в круглую стену на ${(far - room.r).toFixed(2)} м`)
      }
    }
    if (f.y1 > room.y1 + 0.05 && f.kind !== 'stair') {
      bad.push(`«${f.name}» выше потолка на ${(f.y1 - room.y1).toFixed(2)} м`)
    }
    if (f.y0 < floor - 0.15) bad.push(`«${f.name}» уходит под пол на ${(floor - f.y0).toFixed(2)} м`)
  }

  // 3. Висит в воздухе. У мебели должна быть опора: пол, стена или другой
  //    предмет под ней. Плафоны и трубы (`hang`) держатся потолком — их не трогаем.
  for (const f of inner) {
    if (f.kind !== 'furn' && f.kind !== 'small') continue
    if (f.y0 <= floor + 0.06) continue
    // Запас 0.25 м: радиатор и щиток висят на кронштейнах в ладони от стены,
    // и это не «в воздухе», а нормальный способ крепления.
    const onWall =
      f.x0 - room.x0 < 0.25 || room.x1 - f.x1 < 0.25 || f.z0 - room.z0 < 0.25 || room.z1 - f.z1 < 0.25
    if (onWall) continue
    // Опора ищется не по «верх опоры = низ предмета», а по попаданию низа
    // предмета в вертикальный размах опоры. Причина — составные предметы:
    // габарит печи идёт до потолка вместе с её трубой, габарит пульта — до
    // верха экрана, и чайник на печи по строгому сравнению «висел в воздухе».
    // Рамка не знает, где у предмета столешница; знать это ей и не нужно.
    const propped = inner.some(
      (o) =>
        o !== f &&
        f.y0 <= o.y1 + 0.02 &&
        f.y0 >= o.y0 - 0.02 &&
        Math.min(o.x1, f.x1) - Math.max(o.x0, f.x0) > 0.02 &&
        Math.min(o.z1, f.z1) - Math.max(o.z0, f.z0) > 0.02,
    )
    if (!propped) bad.push(`«${f.name}» висит в воздухе: низ на ${(f.y0 - floor).toFixed(2)} м над полом`)
  }

  // 4. Низко висит — но только НАД ПРОХОДОМ. Труба у стены на полутора метрах
  //    никому не мешает: под стеной всё равно не ходят. Штанга сушилки на той
  //    же высоте посреди комнаты — упираешься макушкой. Разницу знает сетка,
  //    поэтому проверка спрашивает её, а не одну высоту.
  for (const f of items) {
    if (f.kind !== 'hang' && f.kind !== 'light') continue
    if (f.y1 < floor + HEAD - 0.15) continue // это не подвес, а мебель
    if (f.y0 >= floor + HEAD || f.y0 <= floor + 1.2) continue
    if (overFreeFloor(g, room, f)) {
      bad.push(`«${f.name}» висит на ${(f.y0 - floor).toFixed(2)} м над проходом — макушка капсулы на ${HEAD}`)
    }
  }

  return { bad, look }
}

/** Проход: свободна ли комната и связаны ли двери между собой. */
function passage(
  room: Room,
  items: Fixture[],
  g: ReturnType<typeof grid>,
): { free: number; bad: string[] } {
  const bad: string[] = []
  const cx = g.cx
  let free = 0
  for (let i = 0; i < g.busy.length; i++) if (!g.busy[i]) free++
  if (!free) return { free: 0, bad: ['пройти негде: свободных клеток нет'] }
  const share = free / Math.max(1, g.usable)

  const doors = items.filter((f) => f.kind === 'door')
  const entries: { name: string; cell: number }[] = []
  for (const d of doors) {
    // Точка перед проёмом ВНУТРИ комнаты: центр двери, сдвинутый от той стены,
    // в которой она сидит. Дверь узкая по одной оси — это и есть стена.
    const dx = (d.x0 + d.x1) / 2
    const dz = (d.z0 + d.z1) / 2
    const thin = d.x1 - d.x0 < d.z1 - d.z0
    const px = thin ? (dx < (room.x0 + room.x1) / 2 ? room.x0 + 0.6 : room.x1 - 0.6) : dx
    const pz = thin ? dz : dz < (room.z0 + room.z1) / 2 ? room.z0 + 0.6 : room.z1 - 0.6
    const cell = nearestFree(g, room, px, pz)
    if (cell < 0) {
      bad.push(`перед проёмом (${f2(dx)}, ${f2(dz)}) не встать: занято на ${R * 2} м вокруг`)
    } else {
      entries.push({ name: `проём (${f2(dx)}, ${f2(dz)})`, cell })
    }
  }

  if (entries.length) {
    const reach = flood(g, entries[0].cell)
    for (const e of entries.slice(1)) {
      if (!reach[e.cell]) bad.push(`от ${entries[0].name} не дойти до ${e.name} — комната разрезана`)
    }
    // Отрезанные куски: угол за шкафом — не беда, но полкомнаты за стеной мебели
    // означает, что расстановка перегородила помещение.
    let cut = 0
    for (let i = 0; i < g.busy.length; i++) if (!g.busy[i] && !reach[i]) cut++
    const area = cut * cx * CELL_Z
    if (area > 2) bad.push(`${area.toFixed(1)} м² свободного пола отрезано от дверей`)
  }

  return { free: share, bad }
}

// --- Печать -------------------------------------------------------------------
let problems = 0
const picked = rooms.filter((r) => !filter || r.name.toLowerCase().includes(filter))

if (!picked.length) {
  console.log(`нет помещения с именем «${filter}». Есть: ${rooms.map((r) => r.name).join(', ')}`)
  process.exit(1)
}

for (const room of picked) {
  const items = (byRoom.get(room.name) ?? []).slice().sort((a, b) => a.x0 - b.x0 || a.z0 - b.z0)
  const floor = room.y0 + 0.5
  const w = room.x1 - room.x0
  const d = room.z1 - room.z0
  const cx = w > 20 ? 0.5 : CELL_X
  const g = grid(room, items, cx)
  const p = passage(room, items, g)
  const c = complaints(room, items, g)
  const bad = [...c.bad, ...p.bad]
  problems += bad.length

  console.log(
    `\n== ${room.name} ${'='.repeat(Math.max(0, 56 - room.name.length))}\n` +
      `  пол ${f2(floor)}  потолок ${f2(room.y1)}  (${(room.y1 - floor).toFixed(2)} м)  ` +
      `размер ${w.toFixed(1)} × ${d.toFixed(1)} м\n` +
      `  предметов ${items.length}  свободного пола ${(p.free * 100).toFixed(0)}%`,
  )
  if (listOnly) {
    if (bad.length) console.log('  ПРЕТЕНЗИИ: ' + bad.join('; '))
    continue
  }

  console.log('\n  план: пол…макушка (' + f2(floor) + '…' + f2(floor + HEAD) + ')')
  for (const l of planOf(room, items, floor + 0.05, floor + HEAD, cx)) console.log(l)

  const above = items.filter((f) => f.y0 >= floor + HEAD)
  if (above.length) {
    console.log('\n  план: выше макушки — что висит под потолком')
    for (const l of planOf(room, above, floor + HEAD, room.y1 + 1, cx)) console.log(l)
  }

  console.log('\n  предметы:')
  for (const f of items) {
    console.log(
      `    ${f.name.padEnd(20)} ${f.kind.padEnd(6)} x ${f2(f.x0)}…${f2(f.x1)}  ` +
        `z ${f2(f.z0)}…${f2(f.z1)}  y ${(f.y0 - floor).toFixed(2)}…${(f.y1 - floor).toFixed(2)} над полом`,
    )
  }

  console.log(bad.length ? '\n  ПРЕТЕНЗИИ:\n    ' + bad.join('\n    ') : '\n  претензий нет')
  // Список «на глаз» печатается всегда, но проверку не роняет: половина его —
  // законная укладка (мешок в контейнере), а половина — предмет, влезший
  // соседу в бок. Различает их только кадр.
  if (c.look.length) console.log('  ПОСМОТРЕТЬ:\n    ' + c.look.join('\n    '))
}

console.log(
  `\n${'-'.repeat(60)}\nпомещений ${picked.length}, предметов ${FIXTURES.length}, ` +
    (problems ? `ПРЕТЕНЗИЙ ${problems}` : 'претензий нет'),
)
process.exit(problems ? 1 : 0)
