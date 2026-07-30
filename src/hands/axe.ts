/**
 * hands/axe.ts — топор.
 *
 * Живёт воткнутым в колоду или в наст; F берёт, F втыкает обратно.
 * В руках: ЛКМ — удар. Один и тот же замах и скалывает наледь с перил,
 * и разбивает брошенный ящик — что именно случилось, решает не топор,
 * а то, во что он попал (`hands/index.ts`).
 *
 * Топор в руках несут ГОЛОВОЙ ВВЕРХ, кромкой вперёд — не как лопату остриём
 * вниз. Модель построена рабочей точкой вниз (конвенция рига), поэтому покой —
 * это переворот: rz≈π ставит голову над кистями (топорище вниз, к рукам),
 * ry доворачивает кромку к прицелу, rx чуть роняет голову вперёд от лица.
 */

import * as THREE from 'three'
import { PALETTE } from '../atmosphere'
import { HeldTool, type Stroke } from './tool'
import { Burst } from './burst'

const REST = new THREE.Euler(-0.2, 0.3, Math.PI + 0.15)
const PIVOT_Y = 0.52 // нижняя кисть на середине топорища — центр вращения
// Голова в покое — справа, чуть ниже середины кадра; топорище уходит вниз,
// к нижне-правому углу (кисти за кадром). Координаты абсолютные, в камере рига.
const TIP = new THREE.Vector3(0.34, -0.17, -0.74)

/**
 * Рубка — диагональный секущий мах: занос головы за правое плечо (топор почти
 * покидает кадр — замах живёт за спиной) → косой бросок сверху-справа
 * вниз-влево-вперёд, кромка ведёт и в кадре контакта ложится под прицел →
 * hitstop в материале → выдёргивание лезвия и оседание. `cross` (tool.ts)
 * чередует диагональ — удары ложатся крест-накрест, как при настоящей работе.
 * Знаки поворотов — для головы НАД пивотом: +rx запрокидывает её за плечо,
 * -rx хлещет вперёд-вниз; -rz кренит занос вправо, +rz проносит голову влево.
 */
export type AxeStroke = 'chop'

const STROKES: Record<AxeStroke, Stroke> = {
  chop: {
    dur: 0.72,
    impact: 0.45,
    punch: { pitch: 1.15, roll: 0.85 },
    px: [[0, 0], [0.37, 0.14, 'io'], [0.45, -0.14, 'in'], [0.525, -0.14, 'hold'], [0.7, -0.05, 'out'], [1, 0, 'out']],
    py: [[0, 0], [0.37, 0.18, 'io'], [0.45, -0.16, 'in'], [0.525, -0.16, 'hold'], [0.7, 0.02, 'out'], [1, 0, 'out']],
    pz: [[0, 0], [0.37, 0.12, 'io'], [0.45, -0.36, 'in'], [0.525, -0.36, 'hold'], [0.7, -0.1, 'out'], [1, 0, 'out']],
    rx: [[0, 0], [0.37, 0.66, 'io'], [0.45, -0.72, 'in'], [0.525, -0.72, 'hold'], [0.7, 0.14, 'out'], [1, 0, 'out']],
    ry: [[0, 0], [0.37, -0.36, 'io'], [0.45, 0.32, 'in'], [0.525, 0.32, 'hold'], [0.7, 0.06, 'out'], [1, 0, 'out']],
    rz: [[0, 0], [0.37, -0.4, 'io'], [0.45, 0.38, 'in'], [0.525, 0.38, 'hold'], [0.7, 0.08, 'out'], [1, 0, 'out']],
  },
}

/**
 * КРОМКА ЛЕЗВИЯ в начале координат, топорище вверх по +Y — та же конвенция,
 * что у лопаты (рабочая точка = origin), потому воткнутый топор стоит на
 * голове, рукоятью вверх, как и положено в колоде.
 */
function buildAxe(): THREE.Group {
  const g = new THREE.Group()
  const steel = new THREE.MeshStandardMaterial({
    color: PALETTE.metalFrost,
    metalness: 0.5,
    roughness: 0.44,
    envMapIntensity: 1.3,
  })
  // Топорище холоднее и темнее натурального дерева: кадр станции уводится
  // грейдингом в синеву, и тёплая рукоять читалась бы жёлтой заплатой.
  const wood = new THREE.MeshStandardMaterial({ color: 0x7a654c, roughness: 0.82, metalness: 0 })

  // Голова: профиль (вперёд — кромка с бородой, назад — обух) выдавлен в толщину.
  // Борода со стороны РУКОЯТИ (в модели рукоять уходит вверх, значит борода —
  // верхний зуб кромки): в руках, головой вверх, она свисает к кистям.
  const s = new THREE.Shape()
  s.moveTo(0, 0.155) // верх кромки — борода чуть свисает к топорищу
  s.lineTo(0, -0.035) // кромка — почти вертикальная линия
  s.quadraticCurveTo(0.07, -0.025, 0.12, 0.0) // нижняя щека к всаду
  s.lineTo(0.175, 0.005) // обух
  s.lineTo(0.175, 0.075)
  s.quadraticCurveTo(0.08, 0.09, 0.045, 0.125) // верхняя щека, подрез к бороде
  s.closePath()

  const headGeo = new THREE.ExtrudeGeometry(s, {
    depth: 0.03,
    bevelEnabled: true,
    bevelThickness: 0.006,
    bevelSize: 0.007,
    bevelSegments: 2,
  })
  headGeo.translate(0, 0, -0.015) // толщина симметрично
  headGeo.rotateY(-Math.PI / 2) // профиль x → мировой z: кромка на z=0, обух сзади
  g.add(new THREE.Mesh(headGeo, steel))

  // топорище: сквозь всад вверх, лёгкий наклон вперёд к голове
  const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.019, 0.023, 0.78, 8), wood)
  shaft.position.set(0, 0.45, 0.152)
  shaft.rotation.x = 0.06
  g.add(shaft)

  // хвост рукояти — утолщение, чтобы кисть не соскальзывала
  const knob = new THREE.Mesh(new THREE.CylinderGeometry(0.026, 0.021, 0.07, 8), wood)
  knob.position.set(0, 0.85, 0.128)
  knob.rotation.x = 0.06
  g.add(knob)

  return g
}

export class Axe extends HeldTool<AxeStroke> {
  /** Скол: ледяная и каменная крошка. Тяжелее снежной, летит скупее. */
  readonly chips: Burst
  /** Снежная пыль, сбитая ударом. Идёт вместе со сколом. */
  readonly dust: Burst

  constructor(scene: THREE.Object3D, view: { add: (o: THREE.Object3D) => void }) {
    super(scene, view, {
      build: buildAxe,
      rest: REST,
      pivotY: PIVOT_Y,
      tip: TIP,
      strokes: STROKES,
      // воткнут лезвием в наст, топорище вверх-назад под углом
      plantPose(world, x, y, z, yaw) {
        world.position.set(x, y + 0.015, z)
        world.rotation.set(-0.72, yaw, 0.1, 'YXZ')
      },
    })
    this.chips = new Burst(scene, {
      color: '0.55, 0.66, 0.74',
      size: 30,
      gravity: 13,
      drag: 2.2,
      max: 140,
    })
    this.dust = new Burst(scene, { size: 44, gravity: 5.5, max: 160 })
  }

  spray(point: THREE.Vector3, dir: THREE.Vector3) {
    this.chips.spawn(point, dir, 14)
    this.dust.spawn(point, dir, 10)
  }

  override update(dt: number, onImpact: (kind: AxeStroke) => boolean) {
    this.chips.update(dt)
    this.dust.update(dt)
    super.update(dt, onImpact)
  }
}
