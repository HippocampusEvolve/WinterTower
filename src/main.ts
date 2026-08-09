/**
 * main.ts — точка входа: рендерер, мир, игрок, цикл.
 * Логика внешнего вида живёт в atmosphere.ts, движение — в player.ts,
 * взгляд — в look.ts, всё, что в руках, — в hands/.
 */

// Штамп версии ставится раньше всего остального по той же причине, по которой
// заставка идёт следом: карты запрашиваются уже при разборе
// `world/materials.ts`, и перехватчик адресов должен стоять до этого. Импорт
// ради побочного эффекта, значений отсюда никто не берёт.
import './asset'

// Заставка загрузки идёт первой строкой не для красоты: она подписывается на
// счётчик лоадеров, а карты запрашиваются уже при разборе `world/materials.ts`.
import { whenLoaded, probe } from './loading'

import * as THREE from 'three'
import { Octree } from 'three/examples/jsm/math/Octree.js'

import { createShell } from './shell'
import { createAtmosphere } from './atmosphere'
import { createLook } from './look'
import { createPlayer } from './player'
import { createHands, type Hands } from './hands'
import { createTouch, touchForced, touchSupported, type Touch } from './touch'
import { createWind } from './wind'
import { createSnow } from './snow'
import { createHaze } from './haze'
import { createAmbient } from './ambient'
import { buildWorld } from './world'
import { heightAt } from './world/terrain'

// --- Рендерер ---------------------------------------------------------------
const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance' })
renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
renderer.setSize(innerWidth, innerHeight)
document.body.appendChild(renderer.domElement)

const scene = new THREE.Scene()

// FOV 62° и небольшой наклон вниз — примерно как на референсном кадре
const camera = new THREE.PerspectiveCamera(62, innerWidth / innerHeight, 0.1, 500)

const atmosphere = createAtmosphere(scene, camera, renderer)

// --- Мир --------------------------------------------------------------------
const t0 = performance.now()
const world = buildWorld()
scene.add(world.terrain, world.solid, world.glows.group)

const t1 = performance.now()
// В дерево идут только постройки: рельеф считается формулой heightAt.
const octree = new Octree().fromGraphNode(world.solid)
console.log(
  `[wintertower] мир собран за ${(t1 - t0).toFixed(0)} мс, octree за ${(performance.now() - t1).toFixed(0)} мс, ` +
    `тёплых источников: ${world.warmCount}`,
)

// Взгляд владеет ориентацией камеры, контроллер — телом. Разделение нужно
// физике: ей требуется чистое направление, без кренов и клевков (см. look.ts).
const look = createLook(camera, renderer.domElement)

// Руки создаются позже игрока (им нужен звук и собранный мир), а шаги и
// приземление они получают отсюда — потому ссылка отложенная, а не прямая.
let hands: Hands | null = null

const player = createPlayer(camera, look, octree, heightAt, world.spawn, world.yaw, {
  onStep: (_x, _y, _z, _side, running, surface) => hands?.sfx.footstep(running, surface),
  onLand: (surface, impact) => {
    hands?.land(impact)
    hands?.sfx.land(surface, impact)
  },
})

// --- Погода ------------------------------------------------------------------
// Ветер один на всех: по нему летит снег и по нему же дышит шум эмбиента.
const wind = createWind()
// Тучам нужна крыша: под крышей хлопья переставляются наружу (snow.ts).
const snow = createSnow(camera, wind, world.indoors)
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
// отдельным проходом со своей камерой — см. hands/viewmodel.ts.
hands = createHands({
  scene,
  camera,
  dom: renderer.domElement,
  look,
  solid: world.solid,
  sun: atmosphere.sun,
  heightAt,
  getAudioBus: () => ambient.bus,
  spawn: world.spawn,
  spawnYaw: world.yaw,
})

// --- Управление пальцем -------------------------------------------------------
// Создаётся только на тач-устройствах: на десктопе ни кнопок, ни слушателей.
// Слой узкий - он пишет оси в тело и крутит взгляд, а что делает «рука» и что
// делают кнопки инструмента, решается здесь.
const touch: Touch | null = touchSupported()
  ? createTouch({
      player,
      look,
      onAction: () => hands?.action(),
      onTool: (slot, down) => hands?.hold(slot, down),
    })
  : null

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
    hands,
    atmosphere,
    octree,
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
const shell = createShell((ev) => {
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
    // Отказ не роняем: браузер держит защитную паузу около секунды после
    // выхода по Esc. Экран входа остаётся открытым и ждёт второго нажатия.
    renderer.domElement.requestPointerLock()?.catch?.(() => {})
  }
})
document.addEventListener('pointerlockchange', () => {
  // Смотрим на фактическую активацию, а не на существование слоя: тач создан
  // и на ноутбуке с сенсорным экраном, но играют там мышью, и пауза по Esc
  // обязана работать.
  if (touch?.active) return // тач-режим паузой курсора не управляется
  if (document.pointerLockElement) shell.close()
  else shell.open()
})

// --- Заставка загрузки ------------------------------------------------------
// Мир собирается кодом и стоит на месте мгновенно, но НЕКРАШЕНЫМ: карты
// доезжают асинхронно, и без заставки игрок первые секунды смотрит на плоские
// цвета палитры, поверх которых прямо у него на глазах проявляется бетон.
//
// Уходит заставка не по загрузке карт, а на кадр позже — после прогрева.
// Прогрев делается НАСТОЯЩИМ кадром, и `renderer.compile()` тут не годится:
// он собирает программы под канвас, а мир рисуется композером в рендер-таргет
// (другое цветовое пространство, а значит другой ключ программы). При первом
// же повороте головы всё за пределами стартового ракурса компилировалось бы
// заново, вместе с заливкой текстур в GPU, — то есть фризом на ровном месте.
// Поэтому: гасим frustum culling у ВСЕЙ сцены, рисуем один кадр под заставкой
// и culling сразу возвращаем.
const loadingEl = document.getElementById('loading')!
let warmed = false

function warmUp() {
  if (warmed) return
  warmed = true
  requestAnimationFrame(() => {
    const culled: THREE.Object3D[] = []
    scene.traverse((o) => {
      if (o.frustumCulled) {
        culled.push(o)
        o.frustumCulled = false
      }
    })
    if (hands) hands.renderWorld(renderer, () => atmosphere.composer.render())
    else atmosphere.composer.render()
    for (const o of culled) o.frustumCulled = true
    loadingEl.classList.add('hidden')
    shell.open() // мир готов — можно звать внутрь
  })
}

whenLoaded(warmUp)
probe() // на случай, если грузить нечего вовсе — см. loading.ts

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

renderer.setAnimationLoop(() => {
  timer.update()

  // потолок на dt: после свёрнутой вкладки не должно телепортировать сквозь стены
  const dt = Math.min(timer.getDelta(), 0.05)
  // Взгляд — ДО физики: идти игрок должен по свежему направлению, а не по
  // прошлокадровому (иначе на быстром развороте движение отстаёт на кадр).
  look.update(dt, player)
  player.update(dt)
  hands?.update(dt, player)
  // Кнопка «рука» появляется, только когда ею есть что сделать, а кнопки
  // инструмента - когда он в руках. Подсказка вещью, а не текстом.
  if (touch?.active && hands) {
    const b = hands.buttons()
    touch.setButtons(b.action, b.tool)
  }
  wind.update(dt)
  snow.update(dt)
  haze.update(dt)
  // За стеной ветер глуше: реестр помещений отвечает, под крышей ли игрок.
  ambient.update(dt, world.indoors(camera.position.x, camera.position.y, camera.position.z))

  // Мир рисуется внутри рук: они накладывают отдачу на камеру перед кадром
  // и снимают сразу после, а сами идут отдельным проходом поверх.
  if (hands) hands.renderWorld(renderer, () => atmosphere.composer.render())
  else atmosphere.composer.render()
})
