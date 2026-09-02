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
import { HeldTool, type Stroke } from 'world-core/core'
import { Burst } from './burst'
import { pz } from './stroke'

const REST = new THREE.Euler(-0.2, 0.3, Math.PI + 0.15)
const PIVOT_Y = 0.52 // нижняя кисть на середине топорища — центр вращения
// Голова в покое — справа, чуть ниже середины кадра; топорище уходит вниз,
// к нижне-правому углу (кисти за кадром). Координаты абсолютные, в камере рига.
const TIP = new THREE.Vector3(0.34, -0.17, -0.74)

/**
 * Рубка — диагональный секущий мах: занос головы за правое плечо (топор почти
 * покидает кадр — замах живёт за спиной) → косой бросок сверху-справа
 * вниз-влево-вперёд, кромка ведёт и в кадре контакта ложится под прицел →
 * hitstop в материале → выдёргивание лезвия и оседание. `cross` (риг ядра)
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
    pz: pz([[0, 0], [0.37, 0.12, 'io'], [0.45, -0.36, 'in'], [0.525, -0.36, 'hold'], [0.7, -0.1, 'out'], [1, 0, 'out']]),
    rx: [[0, 0], [0.37, 0.66, 'io'], [0.45, -0.72, 'in'], [0.525, -0.72, 'hold'], [0.7, 0.14, 'out'], [1, 0, 'out']],
    ry: [[0, 0], [0.37, -0.36, 'io'], [0.45, 0.32, 'in'], [0.525, 0.32, 'hold'], [0.7, 0.06, 'out'], [1, 0, 'out']],
    rz: [[0, 0], [0.37, -0.4, 'io'], [0.45, 0.38, 'in'], [0.525, 0.38, 'hold'], [0.7, 0.08, 'out'], [1, 0, 'out']],
  },
}

/**
 * Гранёный топорик: профили головы и размеры взяты из модели, собранной по
 * картинке-эталону (img2threejs). В модели начало координат — центр всада,
 * кромка смотрит в -X, топорище вниз; конвенция игры обратная — КРОМКА ЛЕЗВИЯ
 * в начале координат, топорище вверх по +Y, та же, что у лопаты (рабочая точка
 * = origin), потому воткнутый топор стоит на голове, рукоятью вверх.
 */
const EDGE_X = 0.1353 // самая выступающая точка кромки — её сдвигаем в ноль
const EYE_Y = 0.156 // всад модели → верх головы, дальше топорище вверх

/**
 * Профиль головы из модели → плоскость игры: горизонталь считаем от кромки,
 * вертикаль переворачиваем (в модели голова сверху, у нас — снизу).
 */
function headShape(points: [number, number][]): THREE.Shape {
  const s = new THREE.Shape()
  points.forEach(([x, y], i) => {
    const px = x + EDGE_X
    const py = EYE_Y - y
    if (i === 0) s.moveTo(px, py)
    else s.lineTo(px, py)
  })
  s.closePath()
  return s
}

/**
 * Деталь головы: плоский профиль, выдавленный в толщину. Фасок нет — грани
 * должны читаться гранями, потому же flatShading у материалов.
 */
function headPart(points: [number, number][], depth: number, material: THREE.Material): THREE.Mesh {
  const geo = new THREE.ExtrudeGeometry(headShape(points), { depth, bevelEnabled: false, steps: 1 })
  geo.translate(0, 0, -depth / 2) // толщина симметрично
  geo.rotateY(-Math.PI / 2) // профиль x → мировой z: кромка на z=0, обух сзади
  return new THREE.Mesh(geo, material)
}

function buildAxe(): THREE.Group {
  const g = new THREE.Group()
  // Сталь лезвия уведена в морозный тон станции; metalness 0 — модель гранёная,
  // блеск ей даёт не отражение, а разный наклон граней к свету.
  const steel = new THREE.MeshStandardMaterial({
    color: PALETTE.metalFrost,
    metalness: 0,
    roughness: 0.45,
    envMapIntensity: 1.3,
    flatShading: true,
  })
  // Крашеная щека — единственное тёплое пятно в кадре, и это к лучшему: топор
  // в синем интерьере станции нужно находить взглядом сразу.
  const paint = new THREE.MeshStandardMaterial({ color: 0x8e3a33, roughness: 0.75, metalness: 0, flatShading: true })
  // Топорище холоднее и темнее натурального дерева: кадр станции уводится
  // грейдингом в синеву, и тёплая рукоять читалась бы жёлтой заплатой.
  const wood = new THREE.MeshStandardMaterial({ color: 0x7a654c, roughness: 0.85, metalness: 0, flatShading: true })

  // Щека — крашеное тело головы, самая толстая деталь (42 мм).
  g.add(headPart([
    [-0.1082, 0.1727], [-0.0593, 0.1443], [0.0322, 0.1289], [0.0296, 0.1211],
    [0.0283, 0.0902], [0.0258, 0.0773], [0.0245, 0.0412], [-0.0219, 0.0412],
    [-0.0219, 0.0541], [-0.0477, 0.0515], [-0.0657, 0.0412], [-0.0838, 0.0283],
    [-0.0966, 0.0155], [-0.1044, 0.0103], [-0.1044, 0.0258],
  ], 0.042, paint))

  // Лезвие — светлая стальная полоса по всей кромке, тоньше щеки (24 мм) и
  // заходит на неё на 4 мм: боковины не совпадают, мерцать нечему.
  g.add(headPart([
    [-0.1185, 0.1907], [-0.1353, 0.1263], [-0.1301, 0.0644], [-0.1185, 0.0258],
    [-0.1121, 0.0039], [-0.1069, 0.0039], [-0.0979, 0.0206], [-0.1031, 0.0515],
    [-0.1031, 0.1263], [-0.1057, 0.1752],
  ], 0.024, steel))

  // Шпора на обухе — крючок, отделённый от щеки вырезом; тоньше её (34 мм),
  // корнем сидит в теле на 3 мм.
  g.add(headPart([
    [0.0296, 0.1263], [0.0644, 0.0979], [0.0283, 0.0876], [0.0245, 0.1108],
  ], 0.034, paint))

  // Топорище: четырёхгранная призма, как в модели (radialSegments 4 — грани, а
  // не гладкий черенок), сквозь всад вверх. Длина добрана до прежней: риг рук
  // (REST, PIVOT_Y, TIP) считает топорище от кромки до хвоста.
  const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.0212, 0.0184, 0.734, 4, 1), wood)
  shaft.position.set(0, 0.473, EDGE_X)
  shaft.rotation.y = Math.PI / 4
  g.add(shaft)

  // Хвост рукояти — раструб, чтобы кисть не соскальзывала; надет на конец
  // топорища с нахлёстом.
  const butt = new THREE.Mesh(new THREE.CylinderGeometry(0.024, 0.0212, 0.03, 4, 1), wood)
  butt.position.set(0, 0.851, EDGE_X)
  butt.rotation.y = Math.PI / 4
  g.add(butt)

  return g
}

export class Axe extends HeldTool {
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

  override update(dt: number, onImpact: (kind: string) => boolean) {
    this.chips.update(dt)
    this.dust.update(dt)
    super.update(dt, onImpact)
  }
}
