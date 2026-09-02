// Подбор качества webp для карт нормалей — счётом, а не на глаз.
//
// Карта нормали это не картинка, а данные: в RGB зашит единичный вектор,
// куда смотрит поверхность. Значит «стало хуже» можно не обсуждать, а
// измерить. Вопрос только в том, что мерить.
//
// ПЕРВЫЙ ЗАХОД БЫЛ НЕВЕРНЫЙ, и это стоит записать. Мерили угол между
// нормалью оригинала и нормалью пережатого файла — и получили, что нынешние
// карты в игре, сделанные на q90, врут на 13 градусов. Число верное, вывод
// из него неверный: lossy webp (это VP8) хранит цветность только в 4:2:0, то
// есть каналы R и G — а в них лежат X и Y нормали — прорежены вдвое по обеим
// осям. Обойти это нельзя: 4:4:4 в lossy webp просто нет, а lossless той же
// карты весит 2.5 МБ вместо 619 КБ. Значит 13 градусов — не поломка, которую
// надо чинить, а цена формата, на которой мир уже год стоит и выглядит так,
// как задумано.
//
// ПОЭТОМУ МЕРИМ ТО, ЧТО ВИДНО. Нормаль попадает на экран через освещение:
// яркость точки это скалярное произведение нормали на направление света.
// Считаем разницу освещённости между картами, в процентах от средней яркости,
// и берём худшее из четырёх направлений света — включая скользящее, где
// рельеф работает сильнее всего и артефакты вылезают первыми.
//
// Порог — 1% средней яркости. Это не подобранное под результат число: закон
// Вебера даёт порог различения около 2% на плавном градиенте, а на
// текстурированной поверхности заметно выше. Отклонение вдвое ниже порога
// глаз не берёт даже зная, куда смотреть.
//
// Оригинал (textures-unused/orig/) участвует как опора: по нему видно, чего
// стоит формат сам по себе, и на этом фоне читается цена нашего шага.
//
// СРАВНИВАЕМ ВНУТРИ ОДНОЙ ЦЕПОЧКИ, и это второе, что пришлось исправить.
// Сначала кандидатов сверяли прямо с файлом из public/ — и q90 разошлось с
// q90 на 5%, хотя это одно и то же качество. Разошлось не качество, а путь:
// файл в проекте прошёл свою перекодировку год назад, наш кандидат идёт
// свежей цепочкой из оригинала, и на карте, состоящей почти целиком из
// высокочастотного шума, даже одинаковые настройки дают разный шум. Пять
// процентов были полом измерителя, а не разницей между вариантами, и порог
// в 1% при таком поле недостижим ни для чего.
//
// Поэтому опорой служит наш же q90 — качество, на котором мир стоит сейчас.
// Цепочка у опоры и у кандидатов одна, пол пропадает, и в число попадает
// ровно то, что мы меняем. Совпадение опоры с файлом в проекте печатается
// отдельной строкой: если цепочка вдруг разъедется с той, которой делали
// текстуры, это будет видно сразу.
//
// Зачем всё это. Три карты (камень, гравий, снег) весили 1.55 МБ из 2.74 МБ
// всех текстур мира: половина отделки ради трёх файлов.
//
// Зависимостей нет намеренно: всё делает ffmpeg, который в проекте уже
// используется для перекодировки (см. docs/JOURNAL.md, сессия 21).
//
//   node tools/normal-quality.mjs            # таблица по всем картам
//   node tools/normal-quality.mjs --apply    # записать выбранное в public/
//   node tools/normal-quality.mjs rock snow  # только эти наборы
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const ORIG = 'textures-unused/orig'
const OUT = 'public/textures'
const TEMP = 'temp/normal-quality'

// Качество, на котором мир стоит сейчас, — оно же опора для сравнения.
const BASE_Q = 90

// Качества для перебора. Ниже 60 у нормалей начинает лезть блочность на
// пологих участках — там градиент плавный, и артефакт виден именно как
// сетка, а не как шум.
const QUALITIES = [60, 65, 70, 75, 80, 85]

// Порог приёмки: отклонение освещённости от опорного качества, в процентах
// от средней яркости. Обоснование — в шапке файла.
const MAX_MEAN_PCT = 1.0

// Направления света в тангентном пространстве. Последнее — скользящее:
// на нём рельеф даёт максимальный контраст, и оно же самое придирчивое.
const LIGHTS = [
  [0, 0, 1],
  [0.5, 0, 0.866],
  [0, 0.5, 0.866],
  [0.6, 0.6, 0.28],
].map(([x, y, z]) => {
  const l = Math.hypot(x, y, z)
  return [x / l, y / l, z / l]
})

const ffmpeg = (args) =>
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args])

/** Разжать файл в сырые байты RGB, при необходимости уменьшив. Через
 *  временный файл: ffmpeg в трубу на Windows рвёт большой вывод. */
function raw(src, size, slot = 'a') {
  const dst = path.join(TEMP, `raw-${slot}.bin`)
  const vf = size ? ['-vf', `scale=${size}:${size}:flags=lanczos`] : []
  ffmpeg(['-i', src, ...vf, '-pix_fmt', 'rgb24', '-f', 'rawvideo', dst])
  return fs.readFileSync(dst)
}

/** Развернуть байты карты в массив единичных нормалей. */
function normals(buf) {
  const n = buf.length / 3
  const out = new Float32Array(n * 3)
  for (let i = 0; i < n; i++) {
    const o = i * 3
    const x = buf[o] / 127.5 - 1
    const y = buf[o + 1] / 127.5 - 1
    const z = buf[o + 2] / 127.5 - 1
    const l = Math.hypot(x, y, z) || 1
    out[o] = x / l
    out[o + 1] = y / l
    out[o + 2] = z / l
  }
  return out
}

/**
 * Насколько разойдётся картинка, если одну карту заменить другой.
 *
 * Для каждого направления света считаем ламбертову освещённость обеих карт и
 * среднее отклонение, отнесённое к средней яркости этого же света. Берём
 * худшее направление: если мир освещён неудачно для карты, отвечать за это
 * будет она, а не усреднение.
 */
function lightDiff(a, b) {
  let worst = 0
  let worstLight = 0
  for (let li = 0; li < LIGHTS.length; li++) {
    const [lx, ly, lz] = LIGHTS[li]
    let sumDiff = 0
    let sumRef = 0
    for (let o = 0; o < a.length; o += 3) {
      const ia = Math.max(0, a[o] * lx + a[o + 1] * ly + a[o + 2] * lz)
      const ib = Math.max(0, b[o] * lx + b[o + 1] * ly + b[o + 2] * lz)
      sumDiff += Math.abs(ia - ib)
      sumRef += ia
    }
    const pct = sumRef > 0 ? (sumDiff / sumRef) * 100 : 0
    if (pct > worst) {
      worst = pct
      worstLight = li
    }
  }
  return { pct: worst, light: worstLight }
}

const kb = (n) => (n / 1024).toFixed(0).padStart(4) + ' КБ'

// --- разбор аргументов ------------------------------------------------------
const args = process.argv.slice(2)
const APPLY = args.includes('--apply')
const only = args.filter((a) => !a.startsWith('--'))

fs.mkdirSync(TEMP, { recursive: true })

// Что берём в работу: набор, у которого в public/ лежит карта нормали, а в
// textures-unused/orig/ сохранился оригинал.
const jobs = []
for (const set of fs.readdirSync(OUT)) {
  if (only.length && !only.includes(set)) continue
  const src = path.join(ORIG, set, 'normal.jpg')
  if (!fs.existsSync(src)) continue
  const current = fs
    .readdirSync(path.join(OUT, set))
    .find((f) => f.startsWith('normal_') && f.endsWith('.webp'))
  if (!current) continue
  // Размер зашит в имя: normal_1k -> 1024, normal_512 -> 512.
  const size = current.includes('_1k') ? 1024 : Number(current.match(/_(\d+)\./)[1])
  jobs.push({ set, src, current, size, dst: path.join(OUT, set, current) })
}

if (!jobs.length) {
  console.error('нечего пережимать: не нашлось пар public/<набор>/normal_*.webp + оригинал')
  process.exit(1)
}

console.log(
  `\nКарты нормалей: ${jobs.length} шт. Порог — отклонение освещённости от нынешней\n` +
    `карты не выше ${MAX_MEAN_PCT}% средней яркости, по худшему из ${LIGHTS.length} направлений света.\n`
)

let before = 0
let after = 0
const chosen = []

for (const job of jobs) {
  const nowSize = fs.statSync(job.dst).size
  before += nowSize

  /** Сжать оригинал нужным качеством. Одна цепочка для опоры и кандидатов. */
  const encode = (q) => {
    const dst = path.join(TEMP, `${job.set}-q${q}.webp`)
    ffmpeg(['-i', job.src, '-vf', `scale=${job.size}:${job.size}:flags=lanczos`,
            '-c:v', 'libwebp', '-quality', String(q), '-compression_level', '6', dst])
    return dst
  }

  // Опора: то же качество, на котором мир стоит сейчас, но пройденное нашей
  // цепочкой — чтобы кандидаты отличались от неё только качеством.
  const baseFile = encode(BASE_Q)
  const baseSize = fs.statSync(baseFile).size
  const baseN = normals(raw(baseFile, null, 'base'))

  // Контроль цепочки: насколько наша опора совпала с файлом, который лежит в
  // проекте. Расхождение здесь — это шум перекодировки, и он же объясняет,
  // почему сравнивать кандидатов напрямую с public/ было бессмысленно.
  const nowN = normals(raw(job.dst, null, 'now'))
  const origN = normals(raw(job.src, job.size, 'orig'))

  console.log(
    `${job.set}/${job.current}  сейчас ${kb(nowSize)}  ` +
      `(от оригинала ${lightDiff(origN, nowN).pct.toFixed(1)}% — цена формата; ` +
      `опора q${BASE_Q} ${kb(baseSize)}, шум цепочки ${lightDiff(nowN, baseN).pct.toFixed(1)}%)`
  )

  let pick = null
  for (const q of QUALITIES) {
    const cand = encode(q)
    const size = fs.statSync(cand).size
    const candN = normals(raw(cand, null, 'cand'))
    const d = lightDiff(baseN, candN)
    const ok = d.pct <= MAX_MEAN_PCT
    console.log(
      `   q${q}  ${kb(size)}  от опоры ${d.pct.toFixed(2)}%  ${ok ? 'проходит' : '—'}`
    )
    // Берём первое (самое лёгкое) качество, которое проходит порог.
    if (ok && !pick) pick = { q, size, file: cand, pct: d.pct }
  }

  if (!pick) {
    console.log('   ни одно качество не прошло порог — оставляем как есть\n')
    after += nowSize
    continue
  }
  if (pick.size >= nowSize) {
    console.log(`   выбранное q${pick.q} не легче текущего — оставляем как есть\n`)
    after += nowSize
    continue
  }
  console.log(
    `   выбор: q${pick.q}, ${kb(pick.size)} вместо ${kb(nowSize)} ` +
      `(-${(100 - (pick.size / nowSize) * 100).toFixed(0)}%), картинка разойдётся на ${pick.pct.toFixed(2)}%\n`
  )
  after += pick.size
  chosen.push({ ...job, ...pick })
}

console.log(
  `Итого: ${(before / 1048576).toFixed(2)} МБ -> ${(after / 1048576).toFixed(2)} МБ ` +
    `(-${((before - after) / 1024).toFixed(0)} КБ)\n`
)

if (!APPLY) {
  console.log('Это разведка. Записать выбранное: node tools/normal-quality.mjs --apply\n')
  process.exit(0)
}

for (const c of chosen) {
  fs.copyFileSync(c.file, c.dst)
  console.log(`записан ${c.dst}  q${c.q}  ${kb(c.size)}`)
}
// Имена файлов не меняем намеренно: размер карты в имени прежний, а от
// годового immutable-кэша спасает штамп содержимого (`?v=` из src/asset.ts,
// таблицу считает vite.config.js). Изменившийся файл приезжает по новому
// адресу сам.
console.log(`\nГотово: ${chosen.length} карт. Дальше — npm run build и выкладка.\n`)
