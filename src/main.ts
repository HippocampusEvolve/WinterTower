/**
 * main.ts — точка входа: рендерер, мир, игрок, цикл.
 * Логика внешнего вида живёт в atmosphere.ts, всё, что в руках, — в hands/.
 *
 * Управление целиком из общего ядра миров (`world-core/core`): тело, взгляд,
 * ввод с намерением, риг инструмента и сцена рук. Мир отдаёт телу только свою
 * форму (`support.ts`) и свои числа — те, которыми походка станции отличается
 * от чужой. Так же живёт Snowfall, и это единственный способ не чинить один и
 * тот же прыжок дважды.
 */

// Штамп версии ставится раньше всего остального по той же причине, по которой
// заставка идёт следом: карты запрашиваются уже при разборе
// `world/materials.ts`, и перехватчик адресов должен стоять до этого. Импорт
// ради побочного эффекта, значений отсюда никто не берёт.
import './asset'

// Заставка загрузки идёт первой строкой не для красоты: она подписывается на
// счётчик лоадеров, а карты запрашиваются уже при разборе `world/materials.ts`.
import './loading'

// Вехи загрузки уходят в трассу boot.js: измерять её надо числами, а не
// секундомером у экрана (`__FTE_BOOT__.trace()` в консоли, в том числе на проде).
const mark = (name: string): void =>
  (window as Window & { __FTE_BOOT__?: { mark(n: string): void } }).__FTE_BOOT__?.mark(name)

import * as THREE from 'three'

import { createShell } from './shell'
import { keepOffline } from './offline'
import { createAtmosphere } from './atmosphere'
import { Body, Input, SmoothLook } from 'world-core/core'
import { createSupport, STEP_UP, type Surface } from './support'
import { createHands, type Hands, type TouchButtons } from './hands'
import { createTouch, touchForced, touchSupported, type Touch } from './touch'
import { createWind } from './wind'
import { createSnow } from './snow'
import { createHaze } from './haze'
import { createAmbient } from './ambient'
import { buildWorld } from './world'
import { buildCollision } from './world/collision'
import { createAwakening } from './awaken'
import { uploadMapsWith } from './world/materials'
import { heightAt } from './world/terrain'

// --- Рендерер ---------------------------------------------------------------
type QualityName = 'high' | 'medium' | 'low'
const params = new URLSearchParams(location.search)
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches
const device = navigator as Navigator & { deviceMemory?: number }
const requestedQuality = params.get('quality')
const autoQuality: QualityName =
  reducedMotion || (device.deviceMemory ?? 4) <= 2 || (navigator.hardwareConcurrency || 4) <= 2
    ? 'low'
    : matchMedia('(pointer: coarse)').matches ||
        (device.deviceMemory ?? 4) <= 4 ||
        (navigator.hardwareConcurrency || 4) <= 4 ||
        devicePixelRatio > 1.75
      ? 'medium'
      : 'high'
const qualityName: QualityName =
  requestedQuality === 'high' || requestedQuality === 'medium' || requestedQuality === 'low'
    ? requestedQuality
    : autoQuality
const qualityDpr = { high: 1.75, medium: 1.35, low: 1 }[qualityName]

const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance' })
renderer.setPixelRatio(Math.min(devicePixelRatio, qualityDpr))
renderer.setSize(innerWidth, innerHeight)
document.body.appendChild(renderer.domElement)

const scene = new THREE.Scene()

// FOV 62° и небольшой наклон вниз — примерно как на референсном кадре
const camera = new THREE.PerspectiveCamera(62, innerWidth / innerHeight, 0.1, 500)

const atmosphere = createAtmosphere(scene, camera, renderer, qualityName)

// --- Мир --------------------------------------------------------------------
const t0 = performance.now()
const world = buildWorld()
scene.add(world.terrain, world.solid, world.glows.group)

const tWorld = performance.now() - t0

// В дерево идут только постройки: рельеф считается формулой heightAt.
//
// Строится оно НЕ здесь и не разом. Раньше в этой строке стояло
// `new Octree().fromGraphNode(world.solid)`, и она одна занимала полторы
// секунды — втрое больше, чем сборка всего мира. Полторы секунды главный
// поток был занят: кадр не рисовался, ответы сети не разбирались, и три
// мегабайта карт стояли в очереди, хотя запрошены были давно. По замеру входа
// первая карта уходила в дело только на 2219-й миллисекунде.
//
// Теперь дерево собирается порциями между кадрами (`world/collision.ts`), и
// то же самое время идёт фоном, пока мир уже виден, а карты уже едут. Дерево
// получается ровно то же — это проверено счётом, `npm run octree`.
let treeReady = false
const collision = buildCollision(world.solid, () => {
  treeReady = true
  mark('дерево коллизий')
  console.log(
    `[wintertower] дерево коллизий готово на ${performance.now().toFixed(0)} мс от старта`,
  )
  tryUnveil()
})
const octree = collision.octree
mark('мир собран')
console.log(`[wintertower] мир собран за ${tWorld.toFixed(0)} мс, тёплых источников: ${world.warmCount}`)

// Взгляд владеет ориентацией камеры, тело — движением. Разделение нужно
// физике: ей требуется чистое направление, без кренов и клевков.
//
// Чувствительность и крен на стрейфе — числа станции: мышь здесь чуть острее
// снежной, а вбок клонит меньше и на большей скорости (там 1.5 м/с, тут 2.5).
const look = new SmoothLook(camera, renderer.domElement, {
  sens: 0.0022,
  strafeRoll: 0.02,
  strafeAt: 2.5,
})
look.setYaw(world.yaw) // спавн смотрит на башню и доворачиваться не должен

// Руки создаются позже игрока (им нужен звук и собранный мир), а шаги и
// приземление они получают отсюда — потому ссылка отложенная, а не прямая.
let hands: Hands | null = null

// Ввод: клавиши, мышь и палец сводятся в одно намерение. F и кнопки мыши
// уходят колбэками — что ими делать, знает только этот мир.
const input = new Input({
  look,
  target: renderer.domElement,
  onAction: () => hands?.action(),
  onTool: (slot, down) => hands?.hold(slot, down),
})

/**
 * Ниже этой отметки мир кончился. Провалиться можно только сквозь дыру в
 * геометрии или соскользнув с отвеса, где пола нет вовсе; молча оставлять
 * человека падать до бесконечности нельзя, и вернуть его есть только куда —
 * на площадку, с которой он вышел.
 */
const FALL_RESET_Y = -120

const player = new Body({
  camera,
  input,
  support: createSupport({ octree, heightAt }),
  spawn: world.spawn,
  onStep: (_x, _z, _dir, _side, running, surface) =>
    hands?.sfx.footstep(running, surface as Surface),
  onLand: (_x, _z, surface, impact) => {
    hands?.land(impact)
    hands?.sfx.land(surface as Surface, impact)
  },

  // --- Числа станции ---------------------------------------------------------
  // Формула движения общая с Snowfall (разгон экспоненциальным догоном целевой
  // скорости), а числа здесь свои: шаг быстрее, прыжок выше, гравитация тяжелее.
  eye: 1.68,
  // Высота капсулы: 1.68 глаза плюс радиус сверху — ровно те 2.02, которыми
  // меряет проходы `tools/room.ts` и компоновку `world/check.ts`. Число одно
  // на всех, и расходиться ему нельзя.
  height: 2.02,
  radius: 0.34,
  walk: 3.4, // м/с — неспешный шаг по снегу
  run: 6.2,
  jump: 8.0,
  gravity: 26,
  bounds: null, // квадрата у станции нет: с гребня уводит рельеф, а не стенка
  // Разгон и торможение у ядра идут одним числом. У башни своего разгона не
  // было вовсе (ускорение 90 м/с² упиралось в потолок скорости за сорок
  // миллисекунд), а торможение шло трением 9 1/с — его и берём.
  accel: 9,
  stepUp: STEP_UP,
  bobWalk: 0.032,
  bobRun: 0.055,
  bobRate: 1.9,
  strideWalk: 1.6,
  strideRun: 2.0,
  // След ставится ровно под ногу: шага вперёд от оси в этом мире не было.
  stepAhead: 0,
  stepSide: 0.17,
  landAt: -4, // мягче — не удар, а просто спуск со ступени
  // Обзор постоянный: раскачки на бегу здесь нет, кадр строился под 62°.
  fov: 62,
  fovRun: 62,
  // Выносливость: полный запас сгорает за 11 с бега, восстанавливается за 9 с
  // стоя и за 20 с на ходу. Числа совпадают со снежными, но записаны явно —
  // это утверждение мира, а не согласие с чужим умолчанием.
  stamina: {
    drain: 1 / 11,
    gainIdle: 1 / 9,
    gainWalk: 1 / 20,
    recover: 0.3,
    runAt: 0.02,
    jumpCost: 0.06,
  },
})

/** Перенести тело, не гоняя его туда физикой. */
function teleport(x: number, y: number, z: number): void {
  player.pos.set(x, y, z)
  player.vel.set(0, 0, 0)
  player.vy = 0
  player.holdY = null
  // Камера переезжает СРАЗУ: иначе кадр между переносом и следующим тиком
  // смотрел бы из покинутой точки, и это читается рывком.
  player.syncCamera()
}

// --- Погода ------------------------------------------------------------------
// Ветер один на всех: по нему летит снег и по нему же дышит шум эмбиента.
const wind = createWind()
// Тучам нужна крыша: под крышей хлопья переставляются наружу (snow.ts).
const snow = createSnow(camera, wind, world.indoors, { high: 1, medium: 0.7, low: 0.4 }[qualityName])
scene.add(snow.group)

// Клубы: неоднородность тумана. Идут отдельной группой, не в `solid`, —
// как и ореолы, иначе билборды попадут в Octree невидимыми стенами.
const haze = createHaze(camera, wind)
scene.add(haze.group)

const ambient = createAmbient(wind)
// Снег, клубы и ореолы читают те же настройки атмосферы — один прогон на всех.
atmosphere.onApply(() => {
  snow.apply()
  haze.apply()
  world.glows.apply()
})

// --- Руки ---------------------------------------------------------------------
// Лопата и топор стоят в мире у точки спавна; F берёт их в руки. Слой рисуется
// отдельным проходом со своей камерой — риг из ядра, см. hands/index.ts.
hands = createHands({
  scene,
  camera,
  look,
  input,
  solid: world.solid,
  sun: atmosphere.sun,
  heightAt,
  getAudioBus: () => ambient.bus,
  spawn: world.spawn,
  spawnYaw: world.yaw,
})

// --- Пробуждение --------------------------------------------------------------
// Вход в мир идёт не переключателем, а появлением: мир проступает из темноты
// сквозь пелену, а по нажатию она отходит вглубь и опущенный взгляд поднимается
// к башне. Модуль владеет на это время туманом, светом и камерой — см.
// awaken.ts, там же про то, почему длительность не зависит от загрузки.
const awakening = createAwakening({
  setVeil: atmosphere.setVeil,
  setLight: atmosphere.setLight,
  look,
  yaw: world.yaw,
  setSound: (level) => ambient.setWake(level),
  // Пустить в мир можно только по готовому дереву коллизий: без него первый же
  // шаг с террасы уронил бы игрока сквозь лестницу.
  ready: () => collision.ready(),
})

// --- Управление пальцем -------------------------------------------------------
// Создаётся только на тач-устройствах: на десктопе ни кнопок, ни слушателей.
// Сам слой — в ядре, здесь остаются иконки станции и правила видимости кнопок
// (touch.ts). Что делают «рука» и кнопки инструмента, тач не решает: обе
// уходят в тот же ввод, что клавиша F и кнопки мыши (см. `Input` выше).
const touch: Touch | null = touchSupported() ? createTouch(input, look) : null

/**
 * Кадр в файл. Горячей клавиши нет (игроку она не нужна), зовётся из консоли:
 * `wt.shot()`. Рисовать надо тут же, своей рукой: буфер не сохраняется между
 * кадрами, и `toBlob` в отрыве от render() снял бы пустоту.
 */
function shot() {
  if (hands) hands.renderWorld(renderer, () => atmosphere.composer.render())
  else atmosphere.composer.render()
  renderer.domElement.toBlob((blob) => {
    if (!blob) return
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `wintertower_${Math.floor(performance.now())}.png`
    a.click()
    URL.revokeObjectURL(a.href)
  })
}

// Отладочный хендл: из консоли браузера доступны камера, игрок, сцена, атмосфера.
// Через него же гоняются автопроверки контроллера. Игрок его не видит и попасть
// в него не может — в кадре не осталось ни панелей, ни счётчиков.
// THREE здесь не для мира, а для проверок: без него из консоли не собрать
// ни Raycaster, ни Vector3, а замер кадра по материалам ведётся именно лучом.
Object.assign(window, {
  wt: {
    shot,
    scene,
    camera,
    player,
    look,
    input,
    teleport,
    // Появление держит физику, пока не отойдёт пелена: автопроверке нужно
    // знать, с какого момента её команды вообще что-то значат.
    awakening,
    hands,
    atmosphere,
    octree,
    collision,
    renderer,
    touch,
    heightAt,
    world,
    wind,
    snow,
    haze,
    ambient,
    THREE,
  },
})

// --- Оболочка мира ----------------------------------------------------------
// Вход, пауза и выход на витрину — общий для всех миров экран (shell.ts).
// Esc браузер обрабатывает сам: он отпускает курсор, а по этому событию
// возвращается экран паузы.
function enterWorld(ev: Event): void {
  // Вход - это конец ожидания: за туманом игрока оставлять нельзя. Если мир
  // успел собраться сам, здесь пусто. Дерево коллизий при этом всё равно
  // держит пелена самого пробуждения (`awakening`), а не туман меню.
  unveilWorld()
  // Дерево коллизий собирается фоном, и войти в мир раньше, чем оно готово,
  // нельзя: без него постройки для игрока не существуют. Доделывать остаток
  // разом (`collision.finish()`) здесь больше не нужно и не годится — это был
  // фриз ровно в тот момент, когда человек ждёт мира. Теперь ожидание
  // накрыто пробуждением: пелена держится, пока дерево не собрано, и всё это
  // время игрок смотрит, как отходит туман, а не в застывший кадр.
  awakening.enter()

  ambient.start() // до жеста пользователя браузер звук не заводит
  // Чем вошли, тем и играем. Раньше выбор шёл по факту «тач вообще возможен»,
  // а `'ontouchstart' in window` истинно на любом ноутбуке с сенсорным
  // экраном: мир уходил в тач-режим, pointer lock не запрашивался никогда, и
  // мышь не могла повернуть взгляд вовсе - как и Esc открыть паузу.
  // Спрашиваем само нажатие: палец это был или мышь. Синтетический клик
  // (Enter с клавиатуры) типа указателя не несёт - тогда решает устройство.
  const byFinger =
    touchForced() ||
    (ev && (ev as PointerEvent).pointerType
      ? (ev as PointerEvent).pointerType !== 'mouse'
      : matchMedia('(pointer: coarse)').matches)
  // На таче pointer lock не запрашиваем: курсора там нет, а запрос на
  // некоторых мобильных браузерах ещё и роняет полноэкранный режим. Значит и
  // экран паузы закрывать некому - закрываем сами.
  if (touch && byFinger) {
    touch.activate()
    shell.close()
  } else {
    // Захват курсора могут и не дать, и это не сбой: браузер отдаёт его только
    // по свежему жесту, а нажатие, пришедшее раньше готовности мира, до него
    // доживает не всегда. Отменять из-за этого вход нельзя, иначе вернётся
    // ровно то, на что жаловались: нажал, а ничего не случилось. Поэтому вход
    // идёт всё равно, а курсор перехватывается первым же движением мыши.
    const lock = renderer.domElement.requestPointerLock() as unknown
    if (lock instanceof Promise) lock.catch(() => softEnter())
  }
}

// Вход без захвата курсора: мир открыт и просыпается, а курсор возьмём на
// первом же нажатии внутри мира.
let awaitingLock = false

function softEnter(): void {
  if (!shell.isOpen()) return
  awaitingLock = true
  shell.close()
}

document.addEventListener('pointerlockerror', softEnter)

addEventListener('pointerdown', () => {
  if (!awaitingLock || document.pointerLockElement || shell.isOpen()) return
  awaitingLock = false
  renderer.domElement.requestPointerLock()
})

const shell = createShell({ onEnter: enterWorld })

document.addEventListener('pointerlockchange', () => {
  // Смотрим на фактическую активацию, а не на существование слоя: тач создан
  // и на ноутбуке с сенсорным экраном, но играют там мышью, и пауза по Esc
  // обязана работать.
  if (touch?.active) return // тач-режим паузой курсора не управляется
  if (document.pointerLockElement) shell.close()
  else shell.open()
})

// --- Заставка загрузки ------------------------------------------------------
// Заставка уходит по ПЕРВОМУ КАДРУ, а не по загруженным картам, и это главное
// решение всей загрузки мира.
//
// Раньше здесь стояло `whenLoaded(warmUp)`: экран держался, пока не приедут
// все карты, — три мегабайта, пятнадцать секунд на 1.5 Мбит/с. Смысл был
// косметический: мир собирается кодом и стоит на месте мгновенно, но
// НЕКРАШЕНЫМ, и не хотелось показывать, как поверх плоского цвета палитры
// проявляется бетон. Цена этой косметики — пятнадцать секунд перед чёрным
// экраном с полосой, и платил её каждый пришедший.
//
// Теперь порядок обратный: кадр рисуется сразу, экран входа зовёт внутрь через
// секунду, а мир одевается за спиной, пока игрок читает титул. Карта, приехав,
// заливается в видеопамять тут же (`uploadMapsWith` ниже) — иначе заливка
// каждой из двух с половиной десятков карт легла бы на случайный игровой кадр.
//
// Прогрев остаётся и делается НАСТОЯЩИМ кадром: `renderer.compile()` тут не
// годится, он собирает программы под канвас, а мир рисуется композером в
// рендер-таргет (другое цветовое пространство, а значит другой ключ
// программы). При первом же повороте головы всё за пределами стартового
// ракурса компилировалось бы заново — фриз на ровном месте. Поэтому: гасим
// frustum culling у ВСЕЙ сцены, рисуем один кадр под заставкой и culling сразу
// возвращаем.
//
// Прогреву картинки карт не нужны вовсе: ключ шейдерной программы зависит от
// того, ЕСТЬ ли у материала карта, а не от того, что на ней нарисовано. Карты
// уже присвоены материалам (пустые, version=0), поэтому программы собираются
// те же самые, что и с готовыми картинками.
//
// И ещё одно, замеренное трассой (03.09.2026): прогрев ОДНИМ кадром с
// погашенным culling'ом занимал 985 мс — столько стояло между вехами «мир
// собран» и «первый кадр». Целую секунду главный поток компилировал программы
// и заливал буферы, и всё это время экран входа не отвечал на нажатие.
// Поэтому прогрев здесь разбит на две части:
//
//   1. ПЕРВЫЙ КАДР — обычный, с живым culling'ом: компилируется только то, что
//      видно из точки входа. Он дёшев, и после него мир можно показывать.
//   2. ОСТАЛЬНАЯ СЦЕНА — порциями по кадрам, с бюджетом на порцию: рисуем
//      столько объектов, сколько влезает, и отдаём кадр браузеру. Размер
//      порции подбирается сам по предыдущей. Идёт под сплошным туманом, но
//      при живом меню — то есть время то же, а кнопка отвечает.
//
// Тот же приём, что `warmSceneSpread` в Snowfall.
const WARM_BUDGET_MS = 12

function drawWarm(): void {
  if (hands) hands.renderWorld(renderer, () => atmosphere.composer.render())
  else atmosphere.composer.render()
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()))
}

let warmed = false

async function warmSpread(): Promise<void> {
  const pend: THREE.Object3D[] = []
  scene.traverse((o) => {
    // Только то, что рисуется: группы и пустышки прогревать нечем, а порции
    // из них состояли бы наполовину.
    const drawable = o as THREE.Object3D & { isMesh?: boolean; isPoints?: boolean; isLine?: boolean }
    if ((drawable.isMesh || drawable.isPoints || drawable.isLine) && o.frustumCulled) pend.push(o)
  })
  mark('прогрев начат')
  let size = 4
  for (let i = 0; i < pend.length; ) {
    const part = pend.slice(i, i + size)
    i += part.length
    for (const o of part) o.frustumCulled = false
    const t = performance.now()
    drawWarm()
    // Дождаться, пока нарисованное действительно нарисуется. Без этого замер
    // врёт в худшую сторону: команды GL уходят в очередь и возвращают
    // управление сразу, компиляция программ идёт лениво, `spent` выходит в
    // единицы миллисекунд - и порция растёт до потолка, а весь отложенный
    // счёт приходит потом одним куском. `finish` делает цену порции честной.
    renderer.getContext().finish()
    const spent = performance.now() - t
    for (const o of part) o.frustumCulled = true
    // Порция растёт, пока кадр укладывается в бюджет, и сжимается, если нет.
    size = spent > WARM_BUDGET_MS ? Math.max(1, size >> 1) : Math.min(32, size + 2)
    await nextFrame()
  }
  mark(`прогрев кончен (${pend.length} объектов)`)
}

function warmUp() {
  if (warmed) return
  warmed = true
  requestAnimationFrame(() => {
    // Первый кадр — обычный: он показывает мир, а не компилирует его целиком.
    drawWarm()
    mark('первый кадр')
    // Экран входа уже открыт — мир лишь забирает его себе. Вместе с ним
    // приходит то, что нажали, пока он собирался: это нажатие и есть вход,
    // просто сделанный раньше, чем мир успел ответить.
    //
    // Туман при этом НЕ снимается: дерево коллизий может быть ещё не собрано,
    // а сцена — не прогрета. Его снимет `tryUnveil`, когда сойдётся всё.
    const pressed = shell.ready()
    if (pressed.enter) enterWorld(pressed.enter)
    startLoop()
    keepOffline() // следующий приход в мир — без сети (offline.ts)
    void warmSpread().then(() => {
      warmDone = true
      tryUnveil()
    })
  })
}

// --- Туман экрана входа -----------------------------------------------------
// Туман снимает не готовность мира к управлению, а его полная сборка: пока он
// сплошной, за меню не видно ни стройки, ни компиляции. Условий два, и оба
// обязательны: собрано дерево коллизий (без него в мир нельзя вовсе) и
// прогрета сцена (иначе первый же поворот головы даст фриз уже в открытом
// мире). К нему же привязано начало появления: пелена мира отходит ровно
// тогда, когда расходится туман меню, а не в пустоту за сплошной подложкой.
let warmDone = false
let worldUnveiled = false

function unveilWorld(): void {
  if (worldUnveiled) return
  worldUnveiled = true
  awakening.reveal() // мир начинает проступать из темноты
  ;(window as Window & { __FTE_BOOT__?: { unveil(): void } }).__FTE_BOOT__?.unveil()
}

function tryUnveil(): void {
  if (treeReady && warmDone) unveilWorld()
}

// Предохранитель: дерево или прогрев могут не упасть, а просто не дойти до
// конца. Оставить человека за туманом навсегда нельзя ни в каком случае.
setTimeout(unveilWorld, 15000)

// Карты заливаются в видеопамять по мере прихода, вне отрисовки.
uploadMapsWith((tex) => renderer.initTexture(tex))

warmUp()

// --- Ресайз -----------------------------------------------------------------
addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight
  camera.updateProjectionMatrix()
  renderer.setSize(innerWidth, innerHeight)
  atmosphere.composer.setSize(innerWidth, innerHeight)
  hands?.setSize(innerWidth, innerHeight)
})

// --- Цикл -------------------------------------------------------------------
// В three r185 Timer живёт в ядре, а не в examples/jsm. Clock объявлен устаревшим.
const timer = new THREE.Timer()
let loopStarted = false
let lastFrameAt = 0

// Отрисовка мира одной ссылкой: замыкание внутри кадра создавало бы новую
// функцию шестьдесят раз в секунду впустую.
const drawWorld = () => atmosphere.composer.render()

// Состояние тач-кнопок живёт одним объектом на всю игру: руки пишут в него,
// тач читает (см. hands.buttons).
const buttonState: TouchButtons = { action: false, tool: null }

function startLoop() {
  if (loopStarted) return
  loopStarted = true
  renderer.setAnimationLoop(frame)
}

function frame(frameAt: number) {
  // На паузе мир рисуется вдесятеро реже: за экраном входа он всё равно почти
  // не меняется, а батарею беречь стоит. Исключение — пробуждение: пелена
  // отходит и взгляд поднимается ИМЕННО на этом экране, и десять кадров в
  // секунду превратили бы плавное появление в дёрганое.
  //
  // И отдельно: пока туман экрана входа сплошной, мира за ним не видно вовсе -
  // рисовать его значит греть видеокарту в пустоту и отбирать кадры у меню.
  // Прогревочный кадр (`warmUp`) идёт мимо этой проверки: он рисует сам, не
  // через цикл, и нужен для компиляции шейдеров.
  // Раньше здесь стояло `!unveiled && !awakening.holds()`, и это не работало:
  // `holds()` истинно от начала появления до самого конца входа, то есть всё
  // время под туманом. Мир честно рисовался в никуда и отбирал кадры у меню.
  // Теперь условие одно: нет тумана - есть кадры. Вход туман снимает сам
  // (`unveilWorld`), так что войти в нерисуемый мир нельзя.
  if (!document.body.classList.contains('unveiled')) return
  if (
    document.body.classList.contains('paused') &&
    !awakening.holds() &&
    frameAt - lastFrameAt < 100
  )
    return
  lastFrameAt = frameAt
  timer.update()

  // потолок на dt: после свёрнутой вкладки не должно телепортировать сквозь стены
  const dt = Math.min(timer.getDelta(), 0.05)
  // Пока идёт пробуждение, игрок не управляет ничем: камерой ведёт awaken.ts,
  // а физику звать нельзя вовсе — дерево коллизий может быть ещё не собрано.
  // Мир вокруг при этом живёт: снег летит, ветер дышит, туман отходит.
  awakening.update(dt)
  if (!awakening.holds()) {
    // Взгляд — ДО физики: идти игрок должен по свежему направлению, а не по
    // прошлокадровому (иначе на быстром развороте движение отстаёт на кадр).
    look.update(dt, player)
    player.update(dt)
    // Провалился сквозь мир — вернуть на площадку. У тела ядра такой оговорки
    // нет и быть не должно: где у мира кончается низ, знает только мир.
    if (player.pos.y < FALL_RESET_Y) teleport(world.spawn.x, world.spawn.y, world.spawn.z)
    hands?.update(dt, player)
  }
  // Кнопка «рука» появляется, только когда ею есть что сделать, а кнопки
  // инструмента - когда он в руках. Подсказка вещью, а не текстом.
  if (touch?.active && hands) {
    hands.buttons(buttonState)
    touch.setButtons(buttonState.action, buttonState.tool)
  }
  wind.update(dt)
  snow.update(dt)
  haze.update(dt)
  // За стеной ветер глуше: реестр помещений отвечает, под крышей ли игрок.
  ambient.update(dt, world.indoors(camera.position.x, camera.position.y, camera.position.z))

  // Мир рисуется внутри рук: они накладывают отдачу на камеру перед кадром
  // и снимают сразу после, а сами идут отдельным проходом поверх.
  if (hands) hands.renderWorld(renderer, drawWorld)
  else atmosphere.composer.render()
}
