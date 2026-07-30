/**
 * hands/viewmodel.ts — слой того, что игрок держит в руках.
 *
 * Предмет в руках живёт в СВОЕЙ сцене со своей камерой. Так устроен любой FPS,
 * и ровно по двум причинам:
 *   1. свой FOV (55° против мировых 62°) — инструмент у края кадра не растянут
 *      перспективой в лопату-лыжу;
 *   2. свой depth-буфер (`clearDepth` перед проходом) — черенок не протыкает
 *      стену, к которой подошли вплотную, и перила, через которые перегнулись.
 *
 * Плата известна и принята: руки не отбрасывают тень в мир и не попадают
 * в постобработку. Второе здесь заметнее, чем в обычной игре, — весь кадр
 * WinterTower проходит через тонмаппинг и грейдинг композитора, поэтому
 * проход рук повторяет тонмаппинг вручную (см. `render`).
 *
 * Поверх позы предмета риг накладывает четыре аддитивных слоя — именно они
 * отличают «предмет прибит к лицу» от «предмет в руках»: отставание от взгляда
 * (sway), собственная качка при ходьбе, дыхание в покое и просадка при
 * приземлении. Слои общие: любой новый инструмент получает их даром.
 */

import * as THREE from 'three'
import { PALETTE, SETTINGS } from '../atmosphere'
import { stepSpring, type Spring } from '../spring'

const VIEW_FOV = 55
const WORLD_FOV = 62 // тот, что стоит у мировой камеры в main.ts

/**
 * Узкий FOV приближает предмет. Чтобы кадр остался прежним, камерное Z множим
 * на это число: экранное положение и размер сохраняются в точности, а
 * собственная перспектива предмета смягчается — ради этого всё и затевалось.
 */
export const VIEW_Z =
  Math.tan(THREE.MathUtils.degToRad(WORLD_FOV / 2)) / Math.tan(THREE.MathUtils.degToRad(VIEW_FOV / 2))

const TAU = Math.PI * 2
const clamp = THREE.MathUtils.clamp

// sway: сколько радиан отставания даёт единица угловой скорости взгляда, и потолок
const SWAY_YAW = 0.02
const SWAY_PITCH = 0.018
const SWAY_MAX = 0.1
const SWAY_SPRING = 9 // 1/с — с какой охотой риг догоняет взгляд

/** Что ригу нужно знать о теле. */
export type ViewBody = {
  bobAmt: number
  bobT: number
  exertion: number
}

export type ViewModel = ReturnType<typeof createViewModel>

export function createViewModel(
  worldCamera: THREE.PerspectiveCamera,
  sun: THREE.DirectionalLight,
  /** То же окружение, что у мира. Без него сталь инструмента отражает пустоту и чернеет. */
  environment: THREE.Texture | null = null,
) {
  const scene = new THREE.Scene() // без тумана: руки в метре от глаза
  scene.environment = environment
  const camera = new THREE.PerspectiveCamera(VIEW_FOV, innerWidth / innerHeight, 0.01, 12)
  const rig = new THREE.Group()
  scene.add(rig)

  // Свет рига — тот же холодный ключ и отсвет снега, что в мире, но пересчитанный
  // в камерное пространство перед каждым кадром: повернулся — блик пополз по
  // штыку, а не приклеен к нему намертво.
  // Числа втрое выше мировых, и это не ошибка подбора. Мир после сцены проходит
  // грейдинг композитора: яркость, контраст и насыщенность поднимают весь кадр,
  // а текстуры вдобавок компенсируются множителем colorGain (`world/materials.ts`).
  // Руки не получают ни того, ни другого — при мировых значениях инструмент
  // выходил тёмным силуэтом на светлом кадре. Подбиралось глазом против станции
  // в тумане, единственно возможным способом.
  const key = new THREE.DirectionalLight(PALETTE.fogFar, SETTINGS.sunLight * 7.4)
  key.castShadow = false
  scene.add(key, key.target)
  const fill = new THREE.HemisphereLight(PALETTE.skyTop, PALETTE.snowShadow, SETTINGS.skyLight * 1.9)
  scene.add(fill)

  const _euler = new THREE.Euler(0, 0, 0, 'YXZ')
  const _q = new THREE.Quaternion()
  const _v = new THREE.Vector3()

  let yaw = 0
  let pitch = 0
  let seeded = false

  let swayYaw = 0
  let swayPitch = 0
  let breathT = 0
  const dip: Spring = { x: 0, v: 0 } // просадка при приземлении

  function add(obj: THREE.Object3D) {
    rig.add(obj)
    obj.traverse((o) => {
      o.castShadow = false // своя сцена — теней в ней всё равно нет, не гоняем впустую
      o.receiveShadow = false
    })
  }

  function setSize(w: number, h: number) {
    camera.aspect = w / h
    camera.updateProjectionMatrix()
  }

  /** Приземление: короткий провал рига вниз (импульс в пружину просадки). */
  function land(impact: number) {
    dip.v -= clamp(Math.abs(impact) * 0.045, 0.05, 0.4)
  }

  function update(dt: number, body: ViewBody) {
    // --- sway: риг отстаёт от поворота взгляда и пружиной догоняет ---
    _euler.setFromQuaternion(worldCamera.quaternion, 'YXZ')
    if (!seeded) {
      yaw = _euler.y
      pitch = _euler.x
      seeded = true
    }
    let dy = _euler.y - yaw
    if (dy > Math.PI) dy -= TAU
    else if (dy < -Math.PI) dy += TAU
    const dp = _euler.x - pitch
    yaw = _euler.y
    pitch = _euler.x

    // цель — угловая скорость взгляда со знаком минус: предмет остаётся позади
    const inv = dt > 1e-4 ? 1 / dt : 0
    const tYaw = clamp(-dy * inv * SWAY_YAW, -SWAY_MAX, SWAY_MAX)
    const tPitch = clamp(-dp * inv * SWAY_PITCH, -SWAY_MAX, SWAY_MAX)
    const k = 1 - Math.exp(-SWAY_SPRING * dt)
    swayYaw += (tYaw - swayYaw) * k
    swayPitch += (tPitch - swayPitch) * k

    // --- bob: своя качка при ходьбе. Риг вне камеры, головную качку он не
    // наследует, поэтому рисует свою — с фазовым отставанием от шага ---
    const amt = body.bobAmt
    const bt = body.bobT - 0.35
    const bobX = Math.cos(bt) * amt * 0.85
    const bobY = Math.sin(bt * 2) * amt * 0.6
    const bobZ = Math.cos(bt * 2) * amt * 0.25
    const bobRoll = Math.cos(bt) * amt * 0.3

    // --- дыхание в покое: тем заметнее, чем сильнее запыхался; на ходу тонет в качке
    const idle = 1 - clamp(amt / 0.04, 0, 1)
    breathT += dt * TAU * (0.22 + 0.35 * body.exertion)
    const bAmp = (0.004 + 0.012 * body.exertion) * idle
    const breathY = Math.sin(breathT) * bAmp
    const breathZ = Math.sin(breathT * 0.5) * bAmp * 0.5

    // --- просадка при приземлении: критически задемпфированная пружина (см. spring.ts)
    stepSpring(dip, 16, dt)

    rig.position.set(
      bobX - swayYaw * 0.18,
      bobY + breathY + dip.x + swayPitch * 0.18,
      (bobZ + breathZ) * VIEW_Z,
    )
    rig.rotation.set(swayPitch + breathY * 1.2, swayYaw, bobRoll - swayYaw * 0.35)
  }

  /**
   * Руки рисуются последним проходом, поверх готового кадра и со своим depth.
   *
   * Тонмаппинг включается только здесь. Мир уходит в буфер композитора и
   * тонмаппится эффектом на выходе (`atmosphere.ts`), у рендерера он выключен —
   * без этой пары строк инструмент оказался бы в другой гамме, чем всё за ним.
   */
  function render(renderer: THREE.WebGLRenderer) {
    const autoClear = renderer.autoClear
    const tone = renderer.toneMapping
    const exposure = renderer.toneMappingExposure

    renderer.autoClear = false
    renderer.toneMapping = THREE.ACESFilmicToneMapping
    renderer.toneMappingExposure = SETTINGS.exposure
    renderer.clearDepth() // свой depth: инструмент не протыкает стены
    renderer.render(scene, camera)

    renderer.toneMappingExposure = exposure
    renderer.toneMapping = tone
    renderer.autoClear = autoClear
  }

  /** Направление ключа пересчитывается в камерное пространство перед кадром. */
  function syncLight() {
    _q.copy(worldCamera.quaternion).invert()
    _v.copy(sun.position).normalize().applyQuaternion(_q).multiplyScalar(5)
    key.position.copy(_v)
  }

  return {
    scene,
    camera,
    rig,
    /** Свет рига вынесен наружу: он подбирается глазом против кадра, а не считается. */
    key,
    fill,
    add,
    setSize,
    land,
    update,
    render: (renderer: THREE.WebGLRenderer) => {
      syncLight()
      render(renderer)
    },
  }
}
