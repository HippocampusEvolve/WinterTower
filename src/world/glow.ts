/**
 * glow.ts — ореолы вокруг тёплых источников.
 *
 * Блум растит нимб вокруг ярких пикселей самой лампы, но не рисует того,
 * ради чего сюда пришли: свет, увязший в снежном воздухе. На референсе
 * дверной проём светит не точкой, а мутным облаком метра на три,
 * и это облако — половина ощущения «холодно и сыро».
 *
 * Ореол = спрайт с радиальным градиентом, аддитивно. Дёшево, всегда лицом
 * к камере, не требует ни объёмного света, ни второго прохода рендера.
 *
 * ВАЖНО: ореолы идут отдельной группой, НЕ в `solid` — иначе плоские
 * «лужи» отсвета попадут в Octree и станут невидимыми ступеньками.
 */

import * as THREE from 'three'
import { NO_NORMALS_LAYER, SETTINGS } from '../atmosphere'

/** Тёплый источник: и точечный свет, и его ореол собираются из одной записи. */
export type Warm = {
  pos: THREE.Vector3
  color: number
  /** Диаметр ореола в метрах. */
  size: number
  /** Яркость относительно общей настройки halo. */
  power: number
  /** Растяжение по первой оси: отсвет на полу тянется от двери, а не лежит блином. */
  stretch?: number
  label: string
}

let sprite: THREE.Texture | null = null

/** Радиальный градиент. Спад квадратичный: линейный читается диском, а не свечением. */
function haloTexture(): THREE.Texture {
  if (sprite) return sprite
  const N = 128
  const c = document.createElement('canvas')
  c.width = c.height = N
  const ctx = c.getContext('2d')!
  const g = ctx.createRadialGradient(N / 2, N / 2, 0, N / 2, N / 2, N / 2)
  for (let i = 0; i <= 10; i++) {
    const t = i / 10
    g.addColorStop(t, `rgba(255,255,255,${Math.pow(1 - t, 2.4).toFixed(3)})`)
  }
  ctx.fillStyle = g
  ctx.fillRect(0, 0, N, N)
  sprite = new THREE.CanvasTexture(c)
  sprite.colorSpace = THREE.SRGBColorSpace
  return sprite
}

export type Glows = { group: THREE.Group; apply: () => void }

/**
 * Собрать ореолы по списку тёплых источников.
 * `spill` — плоское пятно на земле под источником: мокрый бетон возвращает
 * оранжевое обратно в кадр, на референсе это самая заметная деталь у двери.
 */
export function buildGlows(warm: Warm[], spill: Warm[] = []): Glows {
  const group = new THREE.Group()
  group.name = 'glow'
  // Ореола нет в геометрии кадра: он свет, а не предмет. Без этого SSAO
  // затеняет землю под плоским пятном отсвета — см. NO_NORMALS_LAYER.
  group.layers.set(NO_NORMALS_LAYER)
  const tex = haloTexture()
  const mats: { mat: THREE.Material & { opacity: number }; power: number }[] = []
  const halos: { obj: THREE.Object3D; size: number; stretch: number }[] = []

  for (const w of warm) {
    const mat = new THREE.SpriteMaterial({
      map: tex,
      color: w.color,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      // Туман ореолам не нужен: аддитивная примесь тумана делает дальние
      // фонари белёсыми кляксами. Свет в тумане и должен пробивать дальше стен.
      fog: false,
    })
    const s = new THREE.Sprite(mat)
    s.position.copy(w.pos)
    s.renderOrder = 3
    // Слой ставится КАЖДОМУ объекту: в three он не наследуется от родителя,
    // маска группы на детей не распространяется.
    s.layers.set(NO_NORMALS_LAYER)
    group.add(s)
    mats.push({ mat, power: w.power })
    halos.push({ obj: s, size: w.size, stretch: w.stretch ?? 1 })
  }

  for (const w of spill) {
    const mat = new THREE.MeshBasicMaterial({
      map: tex,
      color: w.color,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      fog: false,
      side: THREE.DoubleSide,
    })
    const m = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat)
    m.rotation.x = -Math.PI / 2
    m.position.copy(w.pos)
    m.renderOrder = 3
    m.layers.set(NO_NORMALS_LAYER)
    group.add(m)
    mats.push({ mat, power: w.power })
    halos.push({ obj: m, size: w.size, stretch: w.stretch ?? 1 })
  }

  function apply() {
    for (const m of mats) m.mat.opacity = SETTINGS.halo * m.power
    for (const h of halos) {
      const s = h.size * SETTINGS.haloScale
      h.obj.scale.set(s * h.stretch, s, s)
    }
  }
  apply()

  return { group, apply }
}
