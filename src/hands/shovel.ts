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
import { HeldTool, type Stroke } from './tool'
import { Burst } from './burst'
import { gltf } from '../gltfload'

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

/**
 * Модель собрана в Blender (blender-web-agent-kit) и запечена в один материал:
 * base + ORM, 616 треугольников, один draw call. Конвенцию рига держит сама
 * модель — остриё штыка в НАЧАЛЕ КООРДИНАТ, черенок вверх по +Y, совок открыт
 * в -Z, высота те же 1.45 м, — поэтому кейфреймы, `PIVOT_Y` и `TIP` не тронуты.
 * Прежняя процедурная сборка осталась в истории файла.
 */
const MODEL = 'models/shovel.glb'

let proto: THREE.Group | null = null
const waiting: THREE.Group[] = [] // группы, собранные до того, как модель доехала
let loading: Promise<THREE.Group> | null = null

/** Грузит модель один раз. Прогресс идёт в общую полосу загрузки. */
export function loadShovelModel(): Promise<THREE.Group> {
  if (!loading) {
    loading = gltf()
      .loadAsync(MODEL)
      .then((res) => {
        proto = res.scene
        proto.traverse((o) => {
          const m = o as THREE.Mesh
          if (!m.isMesh) return
          const mat = m.material as THREE.MeshStandardMaterial
          // Атлас у станции свой: обмёрзшая сталь `PALETTE.metalFrost`, дерево
          // серо-холодное, пластик почти графит. Подкрасить общий тёплый атлас
          // множителем не выходит — чтобы сталь стала обмёрзшей, дерево уходит
          // в оранжевый, — поэтому мир печётся отдельно (стадия s6 в наборе
          // сборки), а цвет материала остаётся белым.
          // Металличность и шероховатость лежат в ORM-карте, множители её
          // домножают: roughness=1 оставляет запечённое как есть.
          mat.metalness = 1
          mat.roughness = 1
          mat.envMapIntensity = 1.2
        })
        while (waiting.length) waiting.pop()!.add(proto!.clone(true))
        return proto
      })
  }
  return loading
}

/**
 * Модель не доехала: сеть оборвалась, кэш побился. Молчать нельзя - группа
 * инструмента осталась бы в мире пустой, и лопату можно было бы взять и махать
 * ею: звук, отдача, брызги, всё как надо, но в руках ничего.
 */
export function onShovelModelFail(fn: (e: unknown) => void): void {
  loadShovelModel().catch(fn)
}

/** Остриё штыка в НАЧАЛЕ КООРДИНАТ, черенок вверх по +Y — конвенция рига. */
function buildShovel(): THREE.Group {
  const g = new THREE.Group()
  // tool.ts зовёт build() синхронно и дважды (копия в мире и копия в руках),
  // поэтому группа отдаётся сразу, а модель доедет в неё сама
  if (proto) g.add(proto.clone(true))
  else waiting.push(g)
  return g
}

loadShovelModel()

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
    // Без модели лопаты в мире нет вовсе: уводим её туда, где до неё не
    // дотянуться (радиус подбора - метры), и гасим пустую группу.
    onShovelModelFail((e) => {
      console.warn('модель лопаты не загрузилась, лопаты в мире не будет:', e)
      this.world.visible = false
      this.pos.set(0, -1000, 0)
    })
  }

  spray(point: THREE.Vector3, dir: THREE.Vector3) {
    this.bursts.spawn(point, dir)
  }

  override update(dt: number, onImpact: (kind: ShovelStroke) => boolean) {
    this.bursts.update(dt)
    super.update(dt, onImpact)
  }
}
