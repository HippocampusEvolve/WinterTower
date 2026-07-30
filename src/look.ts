/**
 * look.ts — взгляд от первого лица с телом.
 *
 * До этого мышь крутила `camera.rotation` прямо в контроллере: угол = сумма
 * движений мыши, и больше ничего. Работает, но читается как курсор в редакторе,
 * а не как голова человека, идущего по обмёрзшей площадке.
 *
 * Здесь мышь двигает ЦЕЛЬ (`tYaw`/`tPitch`), а камера догоняет её экспоненциальной
 * пружиной — взгляд «тяжёлый», с мягким доездом после остановки руки. Поверх
 * ложатся четыре аддитивных слоя, все в долях градуса:
 *   * крен в вираж по угловой скорости взгляда;
 *   * крен на стрейфе (классика Quake `cl_rollangle`);
 *   * клевок тангажа при приземлении (пружина, ζ=1 — без отскока);
 *   * микронаклон при разгоне и торможении тела.
 *
 * Кватернион камеры пересобирается заново КАЖДЫЙ кадр из yaw/pitch/roll (YXZ).
 * Это не стилистика, а необходимость: эффекты и отдача инструмента иначе
 * копятся в ориентации и уводят прицел — их пришлось бы снимать вручную.
 *
 * `?rawlook` — сырой взгляд 1:1 без сглаживания и слоёв (если укачивает).
 */

import * as THREE from 'three'
import { stepSpring, type Spring } from './spring'

const SENS = 0.0022 // рад/пиксель — ровно та чувствительность, что была в player.ts
const PI_2 = Math.PI / 2
const clamp = THREE.MathUtils.clamp

/** Что взгляду нужно знать о теле. Ровно это отдаёт `createPlayer`. */
export type LookBody = {
  velocity: THREE.Vector3
  /** Амплитуда качки: по ней взгляд понимает, идём мы или стоим. */
  bobAmt: number
}

export type Look = ReturnType<typeof createLook>

export function createLook(camera: THREE.PerspectiveCamera, dom: HTMLElement) {
  // Все ручки крутятся на живую из консоли: wt.look.cfg.smooth = 24 и т.п.
  const cfg = {
    raw: new URLSearchParams(location.search).has('rawlook'),
    smooth: 14, // 1/с — жёсткость догона взгляда (полудогон ~50 мс)
    turnRoll: 0.005, // рад крена на 1 рад/с поворота взгляда
    turnRollMax: 0.021, // потолок крена в вираж, ~1.2°
    strafeRoll: 0.02, // крен на полном боковом шаге, ~1.1°
    rollRate: 8, // 1/с — пружина входа и выхода крена
    accelPitch: 0.0011, // рад наклона на 1 м/с² продольного разгона
    accelPitchMax: 0.008, // потолок наклона, ~0.45°
  }

  let yaw = 0
  let pitch = 0
  let tYaw = 0
  let tPitch = 0

  let roll = 0
  const kick: Spring = { x: 0, v: 0 } // клевок приземления, рад
  let accSm = 0 // сглаженное продольное ускорение тела
  let prevFwd = 0

  const euler = new THREE.Euler(0, 0, 0, 'YXZ')

  document.addEventListener('mousemove', (e) => {
    if (document.pointerLockElement === null) return
    tYaw -= e.movementX * SENS
    tPitch = clamp(tPitch - e.movementY * SENS, -PI_2 + 0.02, PI_2 - 0.02)
  })

  /** Поставить взгляд без доезда: спавн и телепорт не должны «доворачиваться». */
  function setYaw(y: number, p = 0) {
    yaw = tYaw = y
    pitch = tPitch = p
    euler.set(pitch, yaw, 0, 'YXZ')
    camera.quaternion.setFromEuler(euler)
  }

  /** Приземление: клевок вниз, сила — по вертикальной скорости касания. */
  function land(impact: number) {
    if (cfg.raw) return
    kick.v -= clamp(Math.abs(impact) * 0.1, 0.12, 0.8)
  }

  /**
   * Звать РАНЬШЕ физики игрока: направление движения берётся из камеры,
   * и оно должно быть уже сегодняшним, а не вчерашним.
   */
  function update(dt: number, body: LookBody) {
    const prevYaw = yaw

    if (cfg.raw) {
      yaw = tYaw
      pitch = tPitch
      euler.set(pitch, yaw, 0, 'YXZ')
      camera.quaternion.setFromEuler(euler)
      return
    }

    // догон цели: экспоненциальная пружина — доезд без перерегулирования
    const k = 1 - Math.exp(-cfg.smooth * dt)
    yaw += (tYaw - yaw) * k
    pitch += (tPitch - pitch) * k

    // скорость тела в осях взгляда: right=(cosY,0,-sinY), fwd=(-sinY,0,-cosY)
    const sinY = Math.sin(yaw)
    const cosY = Math.cos(yaw)
    const lat = body.velocity.x * cosY - body.velocity.z * sinY // вправо +
    const fwd = -body.velocity.x * sinY - body.velocity.z * cosY // вперёд +

    // крен: в вираж (по угловой скорости уже сглаженного взгляда) и в сторону стрейфа
    const vYaw = dt > 1e-4 ? (yaw - prevYaw) / dt : 0
    const rollT =
      clamp(vYaw * cfg.turnRoll, -cfg.turnRollMax, cfg.turnRollMax) -
      cfg.strafeRoll * clamp(lat / 2.5, -1, 1)
    roll += (rollT - roll) * (1 - Math.exp(-cfg.rollRate * dt))

    // клевок приземления: критически задемпфированная пружина (см. spring.ts)
    stepSpring(kick, 14, dt)

    // микронаклон при разгоне и торможении
    const acc = dt > 1e-4 ? (fwd - prevFwd) / dt : 0
    prevFwd = fwd
    accSm += (acc - accSm) * (1 - Math.exp(-10 * dt))
    const accP = clamp(-accSm * cfg.accelPitch, -cfg.accelPitchMax, cfg.accelPitchMax)

    euler.set(pitch + kick.x + accP, yaw, roll, 'YXZ')
    camera.quaternion.setFromEuler(euler)
  }

  return {
    update,
    land,
    setYaw,
    cfg,
    lock: () => dom.requestPointerLock(),
    get locked() {
      return document.pointerLockElement !== null
    },
    get yaw() {
      return yaw
    },
    get pitch() {
      return pitch
    },
  }
}
