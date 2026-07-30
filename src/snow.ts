/**
 * snow.ts — снегопад двумя слоями.
 *
 * Слои делают разную работу и потому не сводятся в один:
 *   — ближний: крупные хлопья в 14 м вокруг камеры. Это ДВИЖЕНИЕ. Их немного,
 *     они больше пикселя и дают параллакс при ходьбе;
 *   — дальний: мелкая крупа на 55 м. Это ВЗВЕСЬ. Каждая точка почти не видна,
 *     но вместе они превращают ровный туман в живую пелену.
 *
 * Обе тучи привязаны к камере и заворачиваются по её положению: снег идёт
 * всегда «здесь», а не в конечном объёме, из которого можно выйти.
 * Летят по общему ветру (wind.ts) — тому же, что качает громкость эмбиента.
 *
 * Фаза 5: у туч появилась крыша. Пока помещение было одно, снег внутри него
 * никто не замечал; на кадре из дежурки в ней висело 56 хлопьев (замер, а не
 * впечатление). Частица, попавшая в зарегистрированный объём (`interior.ts`),
 * переставляется под верхнюю грань тучи — то есть падает снаружи заново.
 * Прятать слой целиком нельзя: снег виден в открытую дверь, и его исчезновение
 * читается сильнее, чем хлопья под потолком.
 */

import * as THREE from 'three'
import { NO_NORMALS_LAYER, PALETTE, SETTINGS } from './atmosphere'
import type { Wind } from './wind'

/** Мягкая круглая точка. Без текстуры PointsMaterial рисует резкие квадратики. */
function flakeTexture(): THREE.Texture {
  const c = document.createElement('canvas')
  c.width = c.height = 32
  const ctx = c.getContext('2d')!
  const g = ctx.createRadialGradient(16, 16, 0, 16, 16, 16)
  g.addColorStop(0.0, 'rgba(255,255,255,1)')
  g.addColorStop(0.35, 'rgba(255,255,255,0.75)')
  g.addColorStop(1.0, 'rgba(255,255,255,0)')
  ctx.fillStyle = g
  ctx.fillRect(0, 0, 32, 32)
  const tex = new THREE.CanvasTexture(c)
  tex.colorSpace = THREE.SRGBColorSpace
  return tex
}

type LayerSpec = {
  count: number
  /** Полуразмеры коробки вокруг камеры, м. */
  half: THREE.Vector3
  color: number
  /** Множители к общим настройкам: слои различаются только пропорцией. */
  size: number
  fall: number
  opacity: number
  /** Насколько слой сносит ветром: дальний идёт ровнее, иначе пелена «едет». */
  drag: number
  /** Амплитуда кружения, м/с. */
  swirl: number
}

/** Один слой: облако точек + его собственные скорости. */
function makeLayer(spec: LayerSpec, tex: THREE.Texture) {
  const n = spec.count
  const pos = new Float32Array(n * 3)
  // Разброс по частицам: без него туча летит монолитом, как занавеска.
  const vary = new Float32Array(n)
  const phase = new Float32Array(n)

  for (let i = 0; i < n; i++) {
    pos[i * 3] = (Math.random() * 2 - 1) * spec.half.x
    pos[i * 3 + 1] = (Math.random() * 2 - 1) * spec.half.y
    pos[i * 3 + 2] = (Math.random() * 2 - 1) * spec.half.z
    vary[i] = 0.7 + Math.random() * 0.6
    phase[i] = Math.random() * Math.PI * 2
  }

  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  // Сфера отсечения задаётся руками: центр едет за камерой каждый кадр,
  // а пересчитывать bounding box по 4000 точкам незачем.
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), spec.half.length())

  const mat = new THREE.PointsMaterial({
    color: spec.color,
    map: tex,
    transparent: true,
    depthWrite: false, // хлопья не должны выгрызать друг друга из буфера глубины
    sizeAttenuation: true,
    fog: true, // дальний край тучи растворяется, границы коробки не видно
  })

  const points = new THREE.Points(geo, mat)
  points.frustumCulled = false
  points.renderOrder = 2
  // Хлопьев нет в геометрии кадра: иначе SSAO считает 8200 точек поверхностями
  // и сыплет затенение по всему кадру (см. NO_NORMALS_LAYER в atmosphere.ts).
  points.layers.set(NO_NORMALS_LAYER)

  return { spec, points, geo, mat, pos, vary, phase }
}

type Layer = ReturnType<typeof makeLayer>

export type Snow = ReturnType<typeof createSnow>

/** Точка под крышей? Тучи спрашивают об этом реестр помещений (`interior.ts`). */
export type Indoors = (x: number, y: number, z: number) => boolean

export function createSnow(camera: THREE.Camera, wind: Wind, indoors?: Indoors) {
  const tex = flakeTexture()
  const group = new THREE.Group()
  group.name = 'snow'

  const layers: Layer[] = [
    makeLayer(
      {
        count: SETTINGS.snowNear,
        half: new THREE.Vector3(14, 9, 14),
        color: PALETTE.snowLit,
        size: 1,
        fall: 1,
        opacity: 1,
        drag: 1,
        swirl: 0.55,
      },
      tex,
    ),
    makeLayer(
      {
        count: SETTINGS.snowFar,
        half: new THREE.Vector3(55, 26, 55),
        color: PALETTE.snowShadow,
        size: 0.5,
        fall: 0.75,
        opacity: 0.55,
        drag: 0.85,
        swirl: 0.2,
      },
      tex,
    ),
  ]
  for (const l of layers) group.add(l.points)

  let time = 0

  /** Вернуть координату в отрезок [c-h, c+h] независимо от того, как далеко она ушла. */
  function wrap(v: number, c: number, h: number): number {
    const d = v - c
    return c + d - Math.floor((d + h) / (2 * h)) * 2 * h
  }

  function apply() {
    for (const l of layers) {
      l.mat.size = SETTINGS.snowSize * l.spec.size
      l.mat.opacity = SETTINGS.snowOpacity * l.spec.opacity
    }
  }

  function update(dt: number) {
    time += dt
    const c = camera.position

    for (const l of layers) {
      const { pos, vary, phase, spec } = l
      const wx = wind.vec.x * spec.drag
      const wz = wind.vec.z * spec.drag
      const fall = SETTINGS.snowFall * spec.fall

      for (let i = 0, p = 0; p < pos.length; i++, p += 3) {
        const v = vary[i]
        const ph = phase[i]
        pos[p] += (wx * v + Math.sin(time * 1.7 + ph) * spec.swirl) * dt
        pos[p + 1] -= fall * v * dt
        pos[p + 2] += (wz * v + Math.cos(time * 1.3 + ph) * spec.swirl) * dt

        pos[p] = wrap(pos[p], c.x, spec.half.x)
        pos[p + 1] = wrap(pos[p + 1], c.y, spec.half.y)
        pos[p + 2] = wrap(pos[p + 2], c.z, spec.half.z)

        // Под крышей снега нет: хлопье возвращается под верхнюю грань тучи
        // со случайным сносом. Проверка стоит десяток сравнений на частицу,
        // и её видно только там, где она нужна, — в помещении.
        if (indoors && indoors(pos[p], pos[p + 1], pos[p + 2])) {
          pos[p] = c.x + (Math.random() * 2 - 1) * spec.half.x
          pos[p + 1] = c.y + spec.half.y
          pos[p + 2] = c.z + (Math.random() * 2 - 1) * spec.half.z
        }
      }
      l.geo.attributes.position.needsUpdate = true
      l.geo.boundingSphere!.center.copy(c)
    }
  }

  return { group, update, apply }
}
