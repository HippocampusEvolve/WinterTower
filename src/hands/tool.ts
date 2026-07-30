/**
 * hands/tool.ts — общий риг ручного инструмента.
 *
 * Инструмент живёт в мире (воткнут, лежит, прислонён), F берёт его в руки,
 * F же оставляет там, где стоишь. В руках замахи идут кейфреймами, а правка
 * мира, звук и брызги происходят в момент ВРЕЗАНИЯ, не по клику.
 *
 * Анимация собрана по канону FPS-viewmodel, и три вещи в ней неслучайны:
 *   * ВРАЩЕНИЕ ИДЁТ ВОКРУГ КИСТЕЙ. Модель построена от рабочей точки (остриё,
 *     кромка), поэтому наивный поворот группы гоняет по дуге рукоять, а рабочая
 *     точка стоит на месте — читается как «инструмент двигают», а не «человек
 *     машет». Пивот вынесен на черенок (`pivotY`), и лезвие описывает настоящую
 *     дугу рычага.
 *   * КРИВЫЕ РАЗНЫЕ ПО ФАЗАМ. Замах — `io` (зависает в верхней точке), бросок —
 *     `in` (скорость МАКСИМАЛЬНА ровно в кадре контакта). Симметричный
 *     smoothstep на броске гасит скорость там, где нужен удар, и он «ватный».
 *   * КОНТАКТ — СОБЫТИЕ. За ним подряд: hitstop (поза заморожена), отдача
 *     камеры (`punch`) и жест выхода (рычаг лопаты, выдёргивание топора).
 */

import * as THREE from 'three'
import { stepSpring, type Spring } from '../spring'

const CANCEL = 0.82 // с какой доли цикла принимается следующий замах
const BLEND = 0.06 // с — сшивка поз на стыке цепочки
const PUNCH_W = 18 // 1/с — жёсткость пружины отдачи камеры (ζ=1, оседает ~180 мс)

const POSE = ['px', 'py', 'pz', 'rx', 'ry', 'rz'] as const
type Channel = (typeof POSE)[number]

export const ss = (k: number) => {
  const t = THREE.MathUtils.clamp(k, 0, 1)
  return t * t * (3 - 2 * t)
}

/**
 * Кривая ВХОДА в кейфрейм:
 *   io   — приходим с нулевой скоростью (замах зависает в верхней точке);
 *   in   — разгон: скорость максимальна ровно в кадре контакта;
 *   out  — торможение: передемпфированный возврат, без отскока;
 *   hold — заморозка (hitstop): скорость обнуляется ударом.
 */
const EASE = {
  io: ss,
  in: (k: number) => k * k * k,
  out: (k: number) => 1 - (1 - k) ** 3,
  hold: () => 0,
} as const

export type Ease = keyof typeof EASE
/** Кейфрейм: [доля цикла, значение, кривая входа]. У первого кривой нет. */
export type Key = [number, number] | [number, number, Ease]

export type Stroke = {
  /** Длительность цикла, с. */
  dur: number
  /** Доля цикла, на которой происходит врезание. */
  impact: number
  /** Импульс отдачи камеры в момент контакта. */
  punch: { pitch: number; roll: number }
} & Record<Channel, Key[]>

function track(kf: Key[], u: number): number {
  for (let i = 1; i < kf.length; i++) {
    const [t1, v1, e] = kf[i]
    if (u > t1) continue
    const [t0, v0] = kf[i - 1]
    return v0 + (v1 - v0) * EASE[e ?? 'io']((u - t0) / (t1 - t0))
  }
  return kf[kf.length - 1][1]
}

export type ToolOptions<K extends string> = {
  /** Сборка модели: рабочая точка в начале координат, черенок вверх по +Y. */
  build: () => THREE.Object3D
  /** Покойный наклон в руках. */
  rest: THREE.Euler
  /** Где на черенке лежит нижняя кисть — центр вращения. */
  pivotY: number
  /** Рабочая точка в покое, камерное пространство. */
  tip: THREE.Vector3
  strokes: Record<K, Stroke>
  /** Как модель стоит, оставленная в мире. */
  plantPose: (world: THREE.Object3D, x: number, y: number, z: number, yaw: number) => void
}

/** Что вернул обработчик врезания: попали ли во что-нибудь. */
export type ImpactHandler<K extends string> = (kind: K) => boolean

export class HeldTool<K extends string = string> {
  readonly world: THREE.Object3D
  readonly holder: THREE.Group
  readonly pos = new THREE.Vector3()

  /** Отдача камеры, рад. Накладывается на мировую камеру ровно на время рендера. */
  readonly punch = { pitch: 0, roll: 0 }

  yaw = 0
  held = false

  private strokes: Record<K, Stroke>
  private plantPose: ToolOptions<K>['plantPose']
  private swing: THREE.Group
  private swingT = -1 // < 0 — покой
  private kind: K | null = null
  private stroke: Stroke | null = null
  private dur = 1
  private amp = 1 // разброс амплитуды: цепочка замахов не должна быть метрономом
  private cross = 1 // разброс «диагонали» броска
  private n = 0
  private impactFired = true
  private blendT = BLEND
  private pose: Record<Channel, number> = { px: 0, py: 0, pz: 0, rx: 0, ry: 0, rz: 0 }
  private from: Record<Channel, number> = { px: 0, py: 0, pz: 0, rx: 0, ry: 0, rz: 0 }
  // Отдача живёт двумя пружинами. Угол наружу отдаётся через `punch`, скорость
  // прячется здесь: импульс удара кладётся в СКОРОСТЬ, а не в угол, — старт
  // мягкий, спад упругий.
  private pitchSpring: Spring = { x: 0, v: 0 }
  private rollSpring: Spring = { x: 0, v: 0 }

  /** `scene` — мир (оставленный инструмент), `view` — риг рук (взятый в руки). */
  constructor(scene: THREE.Object3D, view: { add: (o: THREE.Object3D) => void }, opts: ToolOptions<K>) {
    this.strokes = opts.strokes
    this.plantPose = opts.plantPose

    // инструмент в мире — стоит там, где оставили
    this.world = opts.build()
    this.world.visible = false
    scene.add(this.world)

    // В руках: holder — кисти, swing — поза замаха вокруг них, carried — модель,
    // сдвинутая так, чтобы точка (0, pivotY, 0) черенка легла ровно в центр вращения.
    this.holder = new THREE.Group()
    this.holder.visible = false
    this.swing = new THREE.Group()
    this.holder.add(this.swing)

    const carried = opts.build()
    carried.rotation.copy(opts.rest)
    const grip = new THREE.Vector3(0, opts.pivotY, 0).applyEuler(opts.rest)
    carried.position.copy(grip).negate()
    this.swing.add(carried)
    this.holder.position.copy(opts.tip).add(grip) // рабочая точка садится ровно в tip
    view.add(this.holder)
  }

  get busy() {
    return this.swingT >= 0
  }

  /** Поставить инструмент в мире; позу мешей задаёт `plantPose` подкласса. */
  place(x: number, y: number, z: number, yaw: number) {
    this.pos.set(x, y, z)
    this.yaw = yaw
    this.plantPose(this.world, x, y, z, yaw)
    this.world.visible = !this.held
  }

  take() {
    this.held = true
    this.world.visible = false
    this.holder.visible = true
  }

  plant(x: number, y: number, z: number, yaw: number) {
    this.held = false
    this.holder.visible = false
    this.rest()
    this.place(x, y, z, yaw)
  }

  /**
   * Цепочка замахов: следующий принимается уже на исходе оседания (`CANCEL`) —
   * иначе зажатая кнопка ощущается залипшей. Стык поз сшивается блендом.
   */
  trySwing(kind: K): boolean {
    if (!this.held) return false
    if (this.swingT >= 0 && this.swingT / this.dur < CANCEL) return false

    for (const c of POSE) this.from[c] = this.pose[c]
    this.blendT = 0

    this.kind = kind
    this.stroke = this.strokes[kind]
    this.amp = 0.92 + Math.random() * 0.16
    this.dur = this.stroke.dur / (0.94 + Math.random() * 0.12)
    this.cross = this.n++ % 2 ? 1 : 0.55 // диагональ броска гуляет от замаха к замаху
    this.swingT = 0
    this.impactFired = false
    return true
  }

  private rest() {
    this.swingT = -1
    this.blendT = BLEND
    for (const c of POSE) this.pose[c] = 0
    this.swing.position.set(0, 0, 0)
    this.swing.rotation.set(0, 0, 0)
  }

  private kick(p: { pitch: number; roll: number }) {
    this.pitchSpring.v += p.pitch
    this.rollSpring.v += p.roll * this.cross
  }

  private punchStep(dt: number) {
    stepSpring(this.pitchSpring, PUNCH_W, dt)
    stepSpring(this.rollSpring, PUNCH_W, dt)
    this.punch.pitch = this.pitchSpring.x
    this.punch.roll = this.rollSpring.x
  }

  /**
   * `onImpact` зовётся один раз в момент врезания и возвращает, был ли контакт
   * с материей: промах не должен отдавать в камеру.
   */
  update(dt: number, onImpact: ImpactHandler<K>) {
    this.punchStep(dt)
    if (this.swingT < 0) return

    this.swingT += dt
    const u = this.swingT / this.dur
    const s = this.stroke!

    if (!this.impactFired && u >= s.impact) {
      this.impactFired = true
      if (onImpact(this.kind!)) this.kick(s.punch)
    }

    const p = this.pose
    const a = this.amp
    p.px = track(s.px, u) * a * this.cross
    p.py = track(s.py, u) * a
    p.pz = track(s.pz, u) * a
    p.rx = track(s.rx, u) * a
    p.ry = track(s.ry, u) * a * this.cross
    p.rz = track(s.rz, u) * a * this.cross

    // сшивка со старой позой, если замах начат поверх недооседавшего
    if (this.blendT < BLEND) {
      this.blendT += dt
      const k = ss(this.blendT / BLEND)
      for (const c of POSE) p[c] = this.from[c] + (p[c] - this.from[c]) * k
    }

    this.swing.position.set(p.px, p.py, p.pz)
    this.swing.rotation.set(p.rx, p.ry, p.rz)

    if (u >= 1) this.rest()
  }
}
