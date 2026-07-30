/**
 * haze.ts — клубы тумана.
 *
 * `FogExp2` даёт математически гладкое молоко: плотность зависит ровно от
 * дистанции и ни от чего больше. На референсе туман устроен иначе — он
 * СЛОИСТЫЙ: обрыв слева тонет неравномерно, над озером висит пелена гуще,
 * а по гребню тянутся полосы. Именно эта неоднородность превращает
 * неподвижный фон в погоду.
 *
 * Дёшево это делается пятнами: десяток огромных мягких билбордов, медленно
 * плывущих по общему ветру. Объёмного рассеяния здесь нет и не нужно —
 * при непрозрачности в несколько процентов глаз читает их как сгущения
 * того же тумана, а не как отдельные предметы.
 *
 * Три правила, без которых это не работает:
 *   1. Клубы НЕ идут в Octree — как и ореолы, иначе под ногами появятся
 *      невидимые ступеньки.
 *   2. Клубы исключены из буфера нормалей (`NO_NORMALS_LAYER`): SSAO принял бы
 *      их за поверхности и обвёл тенью пол-экрана.
 *   3. Вблизи клуб гаснет. Билборд в 60 метров шириной, в который упёрлась
 *      камера, — это не туман, а серая заливка кадра.
 */

import * as THREE from 'three'
import { NO_NORMALS_LAYER, PALETTE, SETTINGS } from './atmosphere'
import type { Wind } from './wind'

/** Рыхлое пятно: несколько наложенных градиентов, чтобы край не читался кругом. */
function puffTexture(): THREE.Texture {
  const N = 128
  const c = document.createElement('canvas')
  c.width = c.height = N
  const ctx = c.getContext('2d')!
  // Основа — мягкий радиальный спад.
  const g = ctx.createRadialGradient(N / 2, N / 2, 0, N / 2, N / 2, N / 2)
  for (let i = 0; i <= 8; i++) {
    const t = i / 8
    g.addColorStop(t, `rgba(255,255,255,${(Math.pow(1 - t, 2.2) * 0.85).toFixed(3)})`)
  }
  ctx.fillStyle = g
  ctx.fillRect(0, 0, N, N)
  // Поверх — несколько смещённых пятен: ровный круг в кадре читается кругом.
  ctx.globalCompositeOperation = 'lighter'
  for (const [cx, cy, r, a] of [
    [0.36, 0.42, 0.3, 0.5],
    [0.64, 0.38, 0.26, 0.42],
    [0.5, 0.63, 0.34, 0.45],
  ] as const) {
    const gg = ctx.createRadialGradient(cx * N, cy * N, 0, cx * N, cy * N, r * N)
    gg.addColorStop(0, `rgba(255,255,255,${a})`)
    gg.addColorStop(1, 'rgba(255,255,255,0)')
    ctx.fillStyle = gg
    ctx.fillRect(0, 0, N, N)
  }
  const tex = new THREE.CanvasTexture(c)
  tex.colorSpace = THREE.SRGBColorSpace
  return tex
}

type Puff = {
  sprite: THREE.Sprite
  mat: THREE.SpriteMaterial
  /** Своя доля от общей непрозрачности: клубы не должны быть одинаковыми. */
  power: number
  /** Насколько медленнее ветра плывёт этот клуб. */
  drag: number
}

// Объём, в котором живут клубы. Привязан к МИРУ, а не к камере: пелена над
// озером обязана оставаться над озером, когда игрок идёт по гребню.
const BOX = { x0: -95, x1: 45, z0: -150, z1: 25, y0: -22, y1: 16 }

export type Haze = ReturnType<typeof createHaze>

export function createHaze(camera: THREE.Camera, wind: Wind) {
  const group = new THREE.Group()
  group.name = 'haze'
  const tex = puffTexture()
  const puffs: Puff[] = []

  // Детерминированно: пелена не должна перекладываться при каждой перезагрузке.
  let seed = 918273
  const rnd = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0
    return seed / 4294967296
  }

  for (let i = 0; i < 22; i++) {
    const mat = new THREE.SpriteMaterial({
      map: tex,
      // Цвет тумана, но чуть светлее: сгущение должно быть светлее фона,
      // иначе оно читается дымом, а дым в кадре взяться неоткуда.
      color: new THREE.Color(PALETTE.fogFar).lerp(new THREE.Color(PALETTE.skyTop), 0.4),
      transparent: true,
      depthWrite: false,
      // Туман на туман не накладывается: `fog: true` затянул бы клубы тем же
      // молоком, в котором они и так стоят, и дальние пропали бы полностью.
      fog: false,
    })
    const s = new THREE.Sprite(mat)
    const size = 34 + rnd() * 46
    s.scale.set(size, size * (0.42 + rnd() * 0.3), 1)
    s.position.set(
      BOX.x0 + rnd() * (BOX.x1 - BOX.x0),
      BOX.y0 + rnd() * (BOX.y1 - BOX.y0),
      BOX.z0 + rnd() * (BOX.z1 - BOX.z0),
    )
    s.renderOrder = 2
    s.layers.set(NO_NORMALS_LAYER)
    group.add(s)
    puffs.push({ sprite: s, mat, power: 0.5 + rnd() * 0.8, drag: 0.06 + rnd() * 0.1 })
  }

  /** Расстояние, ближе которого клуб гаснет, чтобы не залить собой кадр. */
  const NEAR = 26

  function update(dt: number) {
    const w = wind.vec
    for (const p of puffs) {
      const pos = p.sprite.position
      pos.x += w.x * p.drag * dt
      pos.z += w.z * p.drag * dt
      // Заворачивание по объёму: клуб, ушедший за край, возвращается с другой
      // стороны. Иначе через несколько минут ветер сдует всю пелену за карту.
      if (pos.x < BOX.x0) pos.x = BOX.x1
      if (pos.x > BOX.x1) pos.x = BOX.x0
      if (pos.z < BOX.z0) pos.z = BOX.z1
      if (pos.z > BOX.z1) pos.z = BOX.z0

      const d = pos.distanceTo(camera.position)
      const near = THREE.MathUtils.smoothstep(d, NEAR * 0.45, NEAR)
      p.mat.opacity = SETTINGS.haze * p.power * near
    }
  }

  /** Прогнать настройки: вызывается ползунком в панели «G». */
  function apply() {
    update(0)
  }

  return { group, update, apply }
}
