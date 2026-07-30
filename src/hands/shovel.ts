/**
 * hands/shovel.ts — лопата.
 *
 * Живёт воткнутой в наст; F берёт её в руки, F втыкает там, где стоишь.
 * В руках: ЛКМ — копнуть (срез-штык), ПКМ — уложить снег обратно.
 * Общий риг замахов и отдачи — `tool.ts`; здесь только модель и кейфреймы.
 *
 * Копание — не рубка: ЛКМ гонит штык ТОЛЧКОМ вдоль оси (срез), дуга и сброс
 * кистью принадлежат ПКМ. Оттого два разных набора кейфреймов, а не один
 * с зеркальным знаком.
 */

import * as THREE from 'three'
import { PALETTE } from '../atmosphere'
import { HeldTool, ss, type Stroke } from './tool'
import { Burst } from './burst'

// Покойный наклон. В Snowfall тут стояло 1.18, и при тамошнем мировом FOV 75°
// лопата читалась; здесь кадр у́же, и от такого наклона штык распластывался
// в серую полосу вдоль нижнего края — видно пятно, а не инструмент.
const REST = new THREE.Euler(0.95, -0.12, -0.16)
const PIVOT_Y = 0.75 // где на черенке лежит нижняя кисть — центр вращения

/**
 * Остриё в покое, камерное пространство рига (FOV 55°).
 *
 * Числа абсолютные, а не пересчитанные из мирового FOV: кадр рук задаётся
 * камерой рига и только ею. Y подобран так, чтобы штык с тулейкой СТОЯЛИ
 * В КАДРЕ у нижне-правого края — иначе лопата в покое лежит ниже кромки
 * кадра и «появляется из ниоткуда» на каждом замахе.
 */
const TIP = new THREE.Vector3(0.32, -0.3, -0.8)

/**
 * Раскладка тяжёлого инструмента: замах ~38% цикла, бросок ~8% (быстро!),
 * hitstop ~60 мс, дальше рычаг и оседание. `impact` совпадает с концом броска —
 * с точкой максимального выноса штыка и максимальной его скорости.
 * px/py/pz — камерное смещение кистей; rx/ry/rz — поворот вокруг них.
 * -rx гонит штык вниз-вперёд, +rx поднимает (см. REST).
 */
export type ShovelStroke = 'dig' | 'build'

const STROKES: Record<ShovelStroke, Stroke> = {
  // срез-штык: отвели и подняли → толчок вниз-вперёд → рычаг, ком отрывается
  dig: {
    dur: 0.78,
    impact: 0.46,
    punch: { pitch: 1.7, roll: -0.55 },
    px: [[0, 0], [0.38, 0.04, 'io'], [0.46, -0.05, 'in'], [0.535, -0.05, 'hold'], [0.7, -0.02, 'out'], [1, 0, 'out']],
    py: [[0, 0], [0.38, 0.1, 'io'], [0.46, -0.2, 'in'], [0.535, -0.2, 'hold'], [0.7, 0.02, 'out'], [1, 0, 'out']],
    pz: [[0, 0], [0.38, 0.12, 'io'], [0.46, -0.26, 'in'], [0.535, -0.26, 'hold'], [0.7, -0.1, 'out'], [1, 0, 'out']],
    rx: [[0, 0], [0.38, 0.4, 'io'], [0.46, -0.34, 'in'], [0.535, -0.34, 'hold'], [0.7, 0.16, 'out'], [1, 0, 'out']],
    ry: [[0, 0], [0.38, 0.1, 'io'], [0.46, -0.08, 'in'], [0.535, -0.08, 'hold'], [0.7, -0.02, 'out'], [1, 0, 'out']],
    rz: [[0, 0], [0.38, 0.12, 'io'], [0.46, -0.06, 'in'], [0.535, -0.06, 'hold'], [0.7, 0.02, 'out'], [1, 0, 'out']],
  },
  // намыв: подобрали снизу → вынос вперёд-вверх → сброс кистью
  build: {
    dur: 0.68,
    impact: 0.48,
    punch: { pitch: 0.7, roll: 0.25 },
    px: [[0, 0], [0.4, 0.02, 'io'], [0.48, -0.03, 'in'], [0.545, -0.03, 'hold'], [0.72, -0.01, 'out'], [1, 0, 'out']],
    py: [[0, 0], [0.4, -0.08, 'io'], [0.48, 0.16, 'in'], [0.545, 0.16, 'hold'], [0.72, 0.05, 'out'], [1, 0, 'out']],
    pz: [[0, 0], [0.4, 0.06, 'io'], [0.48, -0.18, 'in'], [0.545, -0.18, 'hold'], [0.72, -0.05, 'out'], [1, 0, 'out']],
    rx: [[0, 0], [0.4, -0.1, 'io'], [0.48, 0.55, 'in'], [0.545, 0.55, 'hold'], [0.72, 0.2, 'out'], [1, 0, 'out']],
    ry: [[0, 0], [0.4, 0.04, 'io'], [0.48, -0.06, 'in'], [0.545, -0.06, 'hold'], [0.72, -0.02, 'out'], [1, 0, 'out']],
    rz: [[0, 0], [0.4, 0.05, 'io'], [0.48, -0.18, 'in'], [0.545, -0.18, 'hold'], [0.72, -0.05, 'out'], [1, 0, 'out']],
  },
}

/** Остриё штыка в НАЧАЛЕ КООРДИНАТ, черенок вверх по +Y — конвенция рига. */
function buildShovel(): THREE.Group {
  const g = new THREE.Group()
  // Обмёрзший инструментальный металл: тот же цвет, что у лестниц и перил
  // станции. Чистой сталью его делать нельзя — в пасмурном тумане нечего
  // отражать, и она читается чёрной дырой в кадре.
  const metal = new THREE.MeshStandardMaterial({
    color: PALETTE.metalFrost,
    metalness: 0.45,
    roughness: 0.52,
    envMapIntensity: 1.2,
  })
  // Дерево серо-холодное: весь кадр уводится грейдингом в синеву, и тёплый
  // черенок в руках выглядел бы вырезанным из другой картинки.
  const wood = new THREE.MeshStandardMaterial({ color: 0x796752, roughness: 0.88, metalness: 0 })

  // штык — выгнутый совок: плоскость с поперечным прогибом и сужением к острию
  const bladeGeo = new THREE.PlaneGeometry(0.24, 0.32, 6, 5)
  const pos = bladeGeo.attributes.position
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i)
    const y = pos.getY(i) // -0.16 (остриё) .. 0.16 (плечи)
    const u = x / 0.12 // -1..1 поперёк
    const taper = 0.72 + 0.28 * ss((y + 0.16) / 0.32) // к острию у́же
    pos.setX(i, x * taper)
    pos.setZ(i, (1 - u * u) * 0.035) // прогиб совка
  }
  bladeGeo.computeVertexNormals()
  const blade = new THREE.Mesh(bladeGeo, metal.clone())
  ;(blade.material as THREE.MeshStandardMaterial).side = THREE.DoubleSide
  blade.position.y = 0.16
  g.add(blade)

  // тулейка (стакан крепления черенка)
  const socket = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.026, 0.14, 8), metal)
  socket.position.set(0, 0.38, 0.028)
  g.add(socket)

  // черенок
  const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.019, 0.021, 0.98, 8), wood)
  shaft.position.set(0, 0.93, 0.03)
  g.add(shaft)

  // ручка-перекладина
  const grip = new THREE.Mesh(new THREE.CylinderGeometry(0.016, 0.016, 0.15, 8), wood)
  grip.rotation.z = Math.PI / 2
  grip.position.set(0, 1.43, 0.03)
  g.add(grip)

  return g
}

export class Shovel extends HeldTool<ShovelStroke> {
  private bursts: Burst

  /** `scene` — мир (воткнутая лопата и брызги), `view` — риг рук. */
  constructor(scene: THREE.Object3D, view: { add: (o: THREE.Object3D) => void }) {
    super(scene, view, {
      build: buildShovel,
      rest: REST,
      pivotY: PIVOT_Y,
      tip: TIP,
      strokes: STROKES,
      // воткнута остриём в снег, слегка наклонена
      plantPose(world, x, y, z, yaw) {
        world.position.set(x, y - 0.12, z)
        world.rotation.set(0.2, yaw, 0.07, 'YXZ')
      },
    })
    this.bursts = new Burst(scene) // снежная крошка из-под штыка
  }

  spray(point: THREE.Vector3, dir: THREE.Vector3) {
    this.bursts.spawn(point, dir)
  }

  override update(dt: number, onImpact: (kind: ShovelStroke) => boolean) {
    this.bursts.update(dt)
    super.update(dt, onImpact)
  }
}
