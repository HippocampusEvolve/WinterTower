/**
 * player.ts — контроллер от первого лица.
 *
 * Физдвижка нет и не будет: капсула + Octree из three дают ходьбу, прыжок,
 * лестницы и скольжение вдоль стен. Этого хватает под задачу «походить по локации».
 *
 * Ориентацией камеры контроллер больше НЕ владеет — она уехала в `look.ts`.
 * Разделение не косметическое: взгляд накладывает крены и клевки, а физике
 * нужен чистый горизонтальный вектор направления. Пока то и другое сидело
 * в одном `camera.rotation`, любой визуальный эффект протекал бы в движение.
 *
 * Сверх ходьбы контроллер ведёт состояние тела — выносливость, запыхавшесть,
 * качку, шаги, удар при приземлении. Само по себе оно ничего не рисует и не
 * звучит: это опорные числа для взгляда (`look.ts`), рук (`hands/`) и звука.
 */

import * as THREE from 'three'
import { Capsule } from 'three/examples/jsm/math/Capsule.js'
import { Octree } from 'three/examples/jsm/math/Octree.js'
import type { Look } from './look'

const GRAVITY = 26
// Ускорение должно перебивать трение выше SPEED_RUN, иначе игрок встаёт на равновесной
// скорости и до бега не разгоняется вовсе. Порог: SPEED_RUN * 9 (коэф. трения) ≈ 56.
const ACCEL_GROUND = 90
const ACCEL_AIR = 8
const SPEED_WALK = 3.4 // м/с — неспешный шаг по снегу
const SPEED_RUN = 6.2
const JUMP = 8.0
const EYE_HEIGHT = 1.68
const RADIUS = 0.34
const FALL_RESET_Y = -120
// Круче ~57° — уже не пол, а скала: по ней съезжаем, а не поднимаемся.
const MIN_FLOOR_NY = 0.55

// --- Выносливость ------------------------------------------------------------
// Бег кончается. Это не механика выживания (её здесь нет), а причина, по которой
// станцию проходят шагом: пробежка через площадку стоит вдоха, и следующие
// полминуты дыхание слышно в звуке и видно в руках.
const STAMINA_DRAIN = 1 / 11 // полный запас сгорает за 11 с бега
const STAMINA_GAIN_IDLE = 1 / 9
const STAMINA_GAIN_WALK = 1 / 20
const STAMINA_RECOVER = 0.3 // ниже этого порога бег заблокирован до восстановления
const JUMP_COST = 0.06

/** На чём стоим. Нужно звуку: снег скрипит, решётка и бетон стучат. */
export type Surface = 'snow' | 'deck'

export type PlayerHooks = {
  /** Шаг: точка подошвы, сторона (±1), бег, поверхность. */
  onStep?: (x: number, y: number, z: number, side: number, running: boolean, surface: Surface) => void
  /** Приземление после падения: `impact` — вертикальная скорость касания (< 0). */
  onLand?: (surface: Surface, impact: number) => void
}

export type Player = ReturnType<typeof createPlayer>

export function createPlayer(
  camera: THREE.PerspectiveCamera,
  look: Look,
  octree: Octree,
  /** Высота рельефа. Земля считается формулой, а не Octree — см. world/terrain.ts. */
  ground: (x: number, z: number) => number,
  spawn: THREE.Vector3,
  spawnYaw = 0,
  hooks: PlayerHooks = {},
) {
  const collider = new Capsule(
    new THREE.Vector3(0, RADIUS, 0),
    new THREE.Vector3(0, EYE_HEIGHT, 0),
    RADIUS,
  )
  const velocity = new THREE.Vector3()
  const keys = new Set<string>()

  let onFloor = false
  let onDeck = false // опора этого кадра — постройка, а не рельеф
  let surface: Surface = 'snow'
  // Сколько секунд без опоры. Нужен, потому что `onFloor` на ходу МИГАЕТ:
  // на каждой ступени, стыке плит и бугре капсула отрывается на кадр-другой.
  // По голому `onFloor` приземление срабатывало по шесть раз за одну прогулку
  // по ровной площадке, а шаги, наоборот, глохли.
  let airT = 0

  // качка, шаги, дыхание
  let bobT = 0
  let bobAmt = 0
  let stride = 0
  let side = 1

  let stamina = 1
  let exhausted = false
  let exertion = 0 // 0..1 — запыхавшесть: копится на бегу, спадает медленно
  let running = false
  let moving = false

  let jumpHeld = false // фронт нажатия: один прыжок на нажатие

  camera.rotation.order = 'YXZ'

  function teleport(p: THREE.Vector3, yaw = 0) {
    collider.start.set(p.x, p.y + RADIUS, p.z)
    collider.end.set(p.x, p.y + EYE_HEIGHT, p.z)
    collider.radius = RADIUS
    velocity.set(0, 0, 0)
    look.setYaw(yaw)
  }
  teleport(spawn, spawnYaw)

  // --- Ввод ----------------------------------------------------------------
  document.addEventListener('keydown', (e) => {
    if (e.code === 'Space') e.preventDefault() // пробел не скроллит страницу
    keys.add(e.code)
  })
  document.addEventListener('keyup', (e) => keys.delete(e.code))
  window.addEventListener('blur', () => keys.clear())

  // --- Направления относительно взгляда ------------------------------------
  const fwd = new THREE.Vector3()
  const side3 = new THREE.Vector3()
  const wish = new THREE.Vector3()

  function readInput(dt: number) {
    camera.getWorldDirection(fwd)
    fwd.y = 0
    fwd.normalize()
    // Вправо от взгляда. Крен вокруг оси зрения само направление не меняет,
    // а вот `camera.up` с ним уезжает — поэтому вбок считаем от мировой
    // вертикали (это и есть cross(fwd, (0,1,0))), а не от вектора камеры.
    side3.set(-fwd.z, 0, fwd.x)

    wish.set(0, 0, 0)
    if (keys.has('KeyW') || keys.has('ArrowUp')) wish.add(fwd)
    if (keys.has('KeyS') || keys.has('ArrowDown')) wish.sub(fwd)
    if (keys.has('KeyD') || keys.has('ArrowRight')) wish.add(side3)
    if (keys.has('KeyA') || keys.has('ArrowLeft')) wish.sub(side3)

    const wantRun = keys.has('ShiftLeft') || keys.has('ShiftRight')
    // Бежать можно только вперёд и только пока есть дыхание.
    running = wantRun && !exhausted && stamina > 0.02 && wish.dot(fwd) > 0.1

    if (wish.lengthSq() > 0) {
      wish.normalize()
      const accel = (onFloor ? ACCEL_GROUND : ACCEL_AIR) * dt
      const cap = running ? SPEED_RUN : SPEED_WALK
      velocity.addScaledVector(wish, accel)

      // ограничиваем только горизонтальную составляющую, чтобы не резать падение
      const hx = velocity.x
      const hz = velocity.z
      const h = Math.hypot(hx, hz)
      if (h > cap) {
        velocity.x = (hx / h) * cap
        velocity.z = (hz / h) * cap
      }
    }

    const wantJump = keys.has('Space')
    if (onFloor && wantJump && !jumpHeld && !exhausted) {
      velocity.y = JUMP
      onFloor = false
      stamina = Math.max(0, stamina - JUMP_COST)
    }
    jumpHeld = wantJump
  }

  // --- Коллизии ------------------------------------------------------------
  const _n = new THREE.Vector3()
  const _push = new THREE.Vector3()

  /** Постройки: лестницы, стены, дорожка. Всё, что легло в Octree. */
  function collideSolid() {
    const hit = octree.capsuleIntersect(collider)
    if (!hit) return

    if (hit.normal.y > 0.1) {
      onFloor = true
      onDeck = true
      // Гасим падение. Без этого velocity.y навсегда остаётся отрицательной:
      // игрок непрерывно «тонет» в земле, его выталкивает по нормали, и на любом
      // уклоне это превращается в неуправляемое сползание вбок.
      if (velocity.y < 0) velocity.y = 0
    } else {
      // скользим вдоль стены вместо того, чтобы залипать в неё
      velocity.addScaledVector(hit.normal, -hit.normal.dot(velocity))
    }
    if (hit.depth >= 1e-10) collider.translate(hit.normal.multiplyScalar(hit.depth))
  }

  /**
   * Рельеф. Проверяем не пересечение с треугольниками, а высоту под ногами:
   * точнее и не зависит от плотности сетки.
   */
  function collideGround() {
    const x = collider.start.x
    const z = collider.start.z
    const depth = ground(x, z) - (collider.start.y - RADIUS)
    if (depth <= 0) return

    // нормаль склона — конечными разностями по той же функции
    const e = 0.6
    _n.set(ground(x - e, z) - ground(x + e, z), 2 * e, ground(x, z - e) - ground(x, z + e)).normalize()

    if (_n.y >= MIN_FLOOR_NY) {
      collider.translate(_push.set(0, depth, 0))
      onFloor = true
      if (velocity.y < 0) velocity.y = 0
    } else {
      // отвес: выталкиваем по нормали и гасим скорость внутрь склона,
      // остаток тянет гравитация — получается сползание вниз, а не подъём по стене
      const into = _n.dot(velocity)
      if (into < 0) velocity.addScaledVector(_n, -into)
      collider.translate(_push.copy(_n).multiplyScalar(depth * _n.y))
    }
  }

  function collide() {
    onFloor = false
    onDeck = false
    collideSolid()
    collideGround()
  }

  /**
   * Проба опоры: приседаем на 6 см и смотрим, есть ли под ногами что-нибудь.
   *
   * Без неё контакт определяется только по факту проникновения, а покоящаяся
   * капсула ни во что не проникает: коллизия выталкивает её ровно на поверхность,
   * следующий подшаг не даёт пересечения, и onFloor гаснет в конце каждого кадра.
   * Последствия тихие и неочевидные: трение считается «воздушным», разгон идёт
   * по ACCEL_AIR, а прыжок не срабатывает вообще никогда.
   */
  const PROBE = 0.06

  function probeFloor(): boolean {
    collider.translate(_push.set(0, -PROBE, 0))
    const hit = octree.capsuleIntersect(collider)
    let found = !!hit && hit.normal.y > 0.1
    if (found) onDeck = true

    if (!found) {
      const x = collider.start.x
      const z = collider.start.z
      if (ground(x, z) - (collider.start.y - RADIUS) > 0) {
        const e = 0.6
        _n.set(
          ground(x - e, z) - ground(x + e, z),
          2 * e,
          ground(x, z - e) - ground(x, z + e),
        ).normalize()
        found = _n.y >= MIN_FLOOR_NY
      }
    }

    collider.translate(_push.set(0, PROBE, 0))
    return found
  }

  // --- Шаг симуляции -------------------------------------------------------
  const step = new THREE.Vector3()

  function update(dt: number) {
    // Трение считаем ДО ввода: тогда ограничение скорости в readInput — последнее,
    // что трогает вектор, и игрок идёт ровно SPEED_WALK, а не «сколько получится».
    const damping = Math.exp(-(onFloor ? 9 : 0.6) * dt) - 1
    velocity.x += velocity.x * damping
    velocity.z += velocity.z * damping
    if (!onFloor) velocity.y -= GRAVITY * dt

    readInput(dt)

    const wasAirT = airT
    // дробим шаг, чтобы на бегу не проскочить сквозь ступень
    const substeps = 3
    const sdt = dt / substeps
    const impact = velocity.y // вертикальная скорость до разрешения коллизий
    for (let i = 0; i < substeps; i++) {
      step.copy(velocity).multiplyScalar(sdt)
      collider.translate(step)
      collide()
    }
    if (!onFloor) onFloor = probeFloor()
    airT = onFloor ? 0 : airT + dt

    // На чём стоим — обновляем только с опоры: в полёте звук шагов не должен
    // мигать между решёткой и снегом.
    if (onFloor) surface = onDeck ? 'deck' : 'snow'

    if (collider.end.y < FALL_RESET_Y) teleport(spawn, look.yaw)

    // --- состояние тела ------------------------------------------------------
    const speed = Math.hypot(velocity.x, velocity.z)
    moving = speed > 0.35
    running = running && moving

    if (running) stamina = Math.max(0, stamina - dt * STAMINA_DRAIN)
    else stamina = Math.min(1, stamina + dt * (moving ? STAMINA_GAIN_WALK : STAMINA_GAIN_IDLE))
    if (stamina <= 0) exhausted = true
    else if (exhausted && stamina > STAMINA_RECOVER) exhausted = false

    if (running) exertion = Math.min(1, exertion + dt / 8)
    else exertion = Math.max(0, exertion - dt / 20)

    // Качка головы. Без неё ходьба ощущается как полёт мышки; амплитуда идёт
    // отдельным числом (а не прямо из скорости), потому что её читают руки:
    // риг viewmodel качается в том же ритме, но с отставанием.
    const targetBob = moving && onFloor ? (running ? 0.055 : 0.032) : 0
    bobAmt += (targetBob - bobAmt) * Math.min(1, 6 * dt)
    if (moving) bobT += dt * speed * 1.9
    const bobY = Math.sin(bobT * 2) * bobAmt
    const bobX = Math.cos(bobT) * bobAmt * 0.55

    camera.position.copy(collider.end)
    camera.position.y += bobY
    camera.position.x += side3.x * bobX * 0.4
    camera.position.z += side3.z * bobX * 0.4

    // Приземление: настоящий полёт, а не мигание опоры на стыке плит.
    if (wasAirT > 0.18 && onFloor && impact < -4 && hooks.onLand) hooks.onLand(surface, impact)

    // Шаги отмеряются пройденной дистанцией, а не таймером: на разной скорости
    // сама собой получается разная частота, и она совпадает с качкой.
    //
    // В воздухе дистанция просто НЕ КОПИТСЯ, но и не сбрасывается. Сброс тут
    // стоял, и на бегу по неровности шаги почти пропадали: каждый мелкий отрыв
    // капсулы от земли обнулял недосчитанный шаг, и на девятнадцати метрах
    // спуска звучало три шага вместо девяти.
    if (moving) {
      // Короткий отрыв (< 0.18 с) шага не прерывает: на ступенях и стыках плит
      // капсула висит в воздухе постоянно, а идущий человек при этом идёт.
      if (airT < 0.18) stride += speed * dt
      const strideLen = running ? 2.0 : 1.6
      if (onFloor && stride >= strideLen) {
        stride = 0
        side *= -1
        hooks.onStep?.(
          collider.start.x + side3.x * side * 0.17,
          collider.start.y - RADIUS,
          collider.start.z + side3.z * side * 0.17,
          side,
          running,
          surface,
        )
      }
    } else {
      stride = Math.min(stride, 0.5)
    }
  }

  return {
    update,
    teleport,
    collider,
    velocity,
    /** Позиция глаза. Совпадает с камерой без учёта качки. */
    get position() {
      return collider.end
    },
    get onFloor() {
      return onFloor
    },
    get surface() {
      return surface
    },
    get moving() {
      return moving
    },
    get running() {
      return running
    },
    get stamina() {
      return stamina
    },
    get exhausted() {
      return exhausted
    },
    get exertion() {
      return exertion
    },
    get bobAmt() {
      return bobAmt
    },
    get bobT() {
      return bobT
    },
  }
}
