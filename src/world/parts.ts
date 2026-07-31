/**
 * parts.ts — сборщик статичной геометрии.
 *
 * Всё неподвижное сливается в один меш через mergeGeometries. Две причины:
 *   1) один draw call вместо сотни;
 *   2) коллизии. Octree читает треугольники из `mesh.matrixWorld`, поэтому
 *      InstancedMesh ему не годится — все инстансы схлопываются в один.
 *
 * Внимание: методы МУТИРУЮТ переданную геометрию (applyMatrix4). Скармливать
 * только свежесозданную, не переиспользовать одну на несколько вызовов.
 */

import * as THREE from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { collectingShapes, noteBox, noteShape, recording } from './fixtures'

const _m = new THREE.Matrix4()
const _q = new THREE.Quaternion()
const _e = new THREE.Euler()
const _p = new THREE.Vector3()
const _dir = new THREE.Vector3()
const _one = new THREE.Vector3(1, 1, 1)
const UP = new THREE.Vector3(0, 1, 0)

/**
 * UV в МЕТРАХ мира: одна единица UV — один метр поверхности.
 *
 * До этого UV приходили из примитивов, а те дают 0…1 НА ГРАНЬ независимо от
 * размера: на стене 20 м и на кабельном лотке 0.25 м один и тот же повтор
 * текстуры. Зерно бетона выходило метровым на стене и миллиметровым на лотке —
 * узкие детали читались полосами другого материала, хотя материал один.
 * Правильное имя дефекта — несогласованная плотность текселей.
 *
 * Метры вместо долей грани переносят выбор масштаба туда, где ему место:
 * в материал (`meters` в `materials.ts` задаёт `repeat = 1/meters`), один раз
 * на всю поверхность мира.
 *
 * Проекция планарная по доминирующей оси нормали — то же, что делает
 * триплanar, но посчитанное один раз на CPU, а не каждый пиксель. Для коробок
 * оно точно: у грани все четыре вершины с одной нормалью, шва не возникает
 * в принципе. Для гранёных валунов швы падают на рёбра, где излом и так есть.
 */
export function planarUV(geo: THREE.BufferGeometry): void {
  const pos = geo.attributes.position as THREE.BufferAttribute
  const nor = geo.attributes.normal as THREE.BufferAttribute | undefined
  if (!nor) return
  const uv = new Float32Array(pos.count * 2)
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i)
    const y = pos.getY(i)
    const z = pos.getZ(i)
    const ax = Math.abs(nor.getX(i))
    const ay = Math.abs(nor.getY(i))
    const az = Math.abs(nor.getZ(i))
    // Горизонтальная грань — вид сверху, вертикальная — вид сбоку.
    if (ay >= ax && ay >= az) {
      uv[i * 2] = x
      uv[i * 2 + 1] = z
    } else if (ax >= az) {
      uv[i * 2] = z
      uv[i * 2 + 1] = y
    } else {
      uv[i * 2] = x
      uv[i * 2 + 1] = y
    }
  }
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2))
}

/**
 * Пометка «UV уже свои, не трогать».
 *
 * Нужна тому, у кого текстура натянута НА объект целиком, а не намощена:
 * альфа-карта потёка (`MAT.grime`) идёт `ClampToEdge` от 0 до 1 по площадке,
 * и метрическая развёртка превратила бы её в одну размазанную полосу.
 */
export function keepUV<T extends THREE.BufferGeometry>(geo: T): T {
  geo.userData.uvDone = true
  return geo
}

/**
 * Метрическая развёртка цилиндра — тоже в метрах, но по собственной оси.
 *
 * Планарной проекцией цилиндр не покрыть: у боковой поверхности нормаль
 * поворачивается по кругу, доминирующая ось скачет четыре раза за оборот,
 * и на каждом скачке шов. Здесь разворот честный: по окружности — длина дуги
 * (2πr), по образующей — высота. Торцы (нормаль вдоль оси) берутся плоско.
 *
 * Считать ОБЯЗАТЕЛЬНО до `Parts.add`, пока цилиндр стоит вдоль своей Y.
 */
export function cylinderUV(geo: THREE.BufferGeometry, r: number, h: number): THREE.BufferGeometry {
  const nor = geo.attributes.normal as THREE.BufferAttribute
  const pos = geo.attributes.position as THREE.BufferAttribute
  const uv = geo.attributes.uv as THREE.BufferAttribute
  const circ = 2 * Math.PI * r
  for (let i = 0; i < uv.count; i++) {
    if (Math.abs(nor.getY(i)) > 0.9) {
      uv.setXY(i, pos.getX(i), pos.getZ(i))
    } else {
      uv.setXY(i, uv.getX(i) * circ, uv.getY(i) * h)
    }
  }
  uv.needsUpdate = true
  return keepUV(geo)
}

/**
 * Метрическая развёртка сферы — по дугам, а не проекцией.
 *
 * Та же болезнь, что у цилиндра, и по той же причине: у сферы нормаль
 * поворачивается во все стороны, доминирующая ось у `planarUV` скачет, и зерно
 * бетона на куполе то растягивается, то съёживается — на скате видно шесть
 * заплат разного масштаба вместо одной поверхности.
 *
 * Здесь развёртка честная: по параллели — длина дуги экватора (2πr), по
 * меридиану — длина дуги от полюса (r · thetaLength). У самой макушки текселя
 * всё равно сходятся: это свойство сферы, а не развёртки, — но на куполе
 * радиусом 9 м макушка занимает в кадре десяток пикселей.
 *
 * Считать ОБЯЗАТЕЛЬНО до `Parts.add`, пока сфера стоит в своих осях.
 */
export function sphereUV(
  geo: THREE.BufferGeometry,
  r: number,
  thetaLength = Math.PI,
): THREE.BufferGeometry {
  const uv = geo.attributes.uv as THREE.BufferAttribute
  const circ = 2 * Math.PI * r
  const arc = r * thetaLength
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * circ, uv.getY(i) * arc)
  uv.needsUpdate = true
  return keepUV(geo)
}

/**
 * Сообщить габарит геометрии в реестр обстановки (`fixtures.ts`).
 *
 * Здесь, а не в самом реестре, потому что здесь единственное место, где
 * геометрия уже стоит в мировых координатах, но ещё не слита в общий меш.
 * После `mergeGeometries` предметов нет — есть один мешок треугольников.
 *
 * Пока никакой предмет не открыт, вызов стоит одно сравнение: рамка считается
 * только под запись.
 */
function note(geo: THREE.BufferGeometry): void {
  if (!recording()) return
  geo.computeBoundingBox()
  const b = geo.boundingBox!
  noteBox(b.min.x, b.min.y, b.min.z, b.max.x, b.max.y, b.max.z)
  // Форма предмета - только когда её просят (внешняя проверка). Рамкой вопрос
  // «влез ли предмет соседу в бок» не решается, а в браузере форма не нужна.
  if (collectingShapes()) noteShape(triangles(geo))
}

/** Треугольники геометрии плоским списком. Координаты уже мировые: матрица применена выше. */
function triangles(geo: THREE.BufferGeometry): number[] {
  const pos = geo.attributes.position as THREE.BufferAttribute
  const idx = geo.index
  const out: number[] = []
  const push = (i: number) => out.push(pos.getX(i), pos.getY(i), pos.getZ(i))
  if (idx) for (let i = 0; i < idx.count; i++) push(idx.getX(i))
  else for (let i = 0; i < pos.count; i++) push(i)
  return out
}

/** Детерминированный ГПСЧ. Мир должен выглядеть одинаково при каждой перезагрузке. */
export function rng(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 4294967296
  }
}

export class Parts {
  private geos: THREE.BufferGeometry[] = []

  /** Произвольная геометрия: центр в (x,y,z), поворот в радианах. */
  add(geo: THREE.BufferGeometry, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0): this {
    _q.setFromEuler(_e.set(rx, ry, rz))
    geo.applyMatrix4(_m.compose(_p.set(x, y, z), _q, _one))
    // Индекс проставляется всем, у кого его нет, и это не формальность.
    // `mergeGeometries` сливает либо всё индексированное, либо всё нет: коробки
    // индекс имеют, а `IcosahedronGeometry` — нет, и первая же снежная шапка,
    // положенная на валун в общий сборщик с шапками коробов, роняла сборку
    // мира целиком. Тривиальный индекс дешевле обратной операции: он не
    // дублирует вершины, в отличие от `toNonIndexed`.
    if (!geo.index) {
      const n = geo.attributes.position.count
      const idx = new Uint32Array(n)
      for (let i = 0; i < n; i++) idx[i] = i
      geo.setIndex(new THREE.BufferAttribute(idx, 1))
    }
    // Развёртка считается ПОСЛЕ матрицы: проекция мировая, поэтому у двух
    // соседних коробок зерно продолжается, а не начинается заново.
    if (!geo.userData.uvDone) planarUV(geo)
    note(geo)
    this.geos.push(geo)
    return this
  }

  /** Коробка по центру. */
  box(w: number, h: number, d: number, x: number, y: number, z: number, ry = 0): this {
    return this.add(new THREE.BoxGeometry(w, h, d), x, y, z, 0, ry, 0)
  }

  /** Коробка, стоящая подошвой на уровне y. */
  boxOn(w: number, h: number, d: number, x: number, y: number, z: number, ry = 0): this {
    return this.box(w, h, d, x, y + h / 2, z, ry)
  }

  /**
   * Коробка по габаритам: от (x0,z0) до (x1,z1), подошва на y.
   *
   * Вырожденная плита (нулевая сторона) молча пропускается, и это не
   * косметика. `BoxGeometry(w, h, 0)` — не пустота, а две совпадающие
   * плоскости: в кадре их не видно, но Octree считает их стеной. Ровно так
   * потолок, «нулевой» по построению (`slab(..., zB, z1, ...)` при zB === z1),
   * встал невидимой перегородкой поперёк прохода между секциями корпуса —
   * час поисков по лучам и треугольникам.
   */
  slab(x0: number, x1: number, z0: number, z1: number, y: number, h: number): this {
    if (Math.abs(x1 - x0) < 1e-4 || Math.abs(z1 - z0) < 1e-4 || Math.abs(h) < 1e-4) return this
    return this.box(
      Math.abs(x1 - x0),
      h,
      Math.abs(z1 - z0),
      (x0 + x1) / 2,
      y + h / 2,
      (z0 + z1) / 2,
    )
  }

  /** Вертикальная труба подошвой на y. */
  pipe(r: number, h: number, x: number, y: number, z: number, seg = 8): this {
    return this.add(cylinderUV(new THREE.CylinderGeometry(r, r, h, seg, 1), r, h), x, y + h / 2, z)
  }

  /** Труба между двумя точками — перила, раскосы, растяжки. */
  strut(r: number, ax: number, ay: number, az: number, bx: number, by: number, bz: number, seg = 5): this {
    _dir.set(bx - ax, by - ay, bz - az)
    const len = _dir.length()
    if (len < 1e-4) return this
    const geo = cylinderUV(new THREE.CylinderGeometry(r, r, len, seg, 1), r, len)
    _q.setFromUnitVectors(UP, _dir.divideScalar(len))
    geo.applyMatrix4(_m.compose(_p.set((ax + bx) / 2, (ay + by) / 2, (az + bz) / 2), _q, _one))
    // Своя матрица — значит и своя запись в реестр: `strut` идёт мимо `add`,
    // и без этой строки перила с тросами выпали бы из карты помещения.
    note(geo)
    this.geos.push(geo)
    return this
  }

  get empty(): boolean {
    return this.geos.length === 0
  }

  /** Слить накопленное в один меш. Сборщик после этого пуст и готов к переиспользованию. */
  mesh(mat: THREE.Material, name = ''): THREE.Mesh {
    const geo = mergeGeometries(this.geos, false)!
    for (const g of this.geos) g.dispose()
    this.geos = []
    addSmoothNormals(geo)
    const m = new THREE.Mesh(geo, mat)
    m.name = name
    return m
  }
}

/**
 * Атрибуты снежного слоя (`materials.ts`, `snowify`).
 *
 * `aSmooth` — нормаль, УСРЕДНЁННАЯ ПО ПОЗИЦИИ, и без неё вздутие рвёт геометрию.
 * У коробки вершины на ребре продублированы: у копии с верхней грани нормаль
 * вверх, у копии с боковой — в сторону. Поднимая вершины по собственной
 * нормали, верхнюю грань уводит вверх, а боковую оставляет на месте — на кромке
 * появляется щель во всю толщину снега. Средняя нормаль у обеих копий ОДНА
 * (на ребре она наклонена под 45°), поэтому обе копии поднимаются одинаково,
 * шва не возникает, а кромка получает скос — то самое, чего добивались формой
 * снежной шапки в фазе 9, только теперь на КАЖДОЙ грани мира.
 *
 * Маски «под крышей» здесь НЕТ, и это результат неудачи: вершинный атрибут
 * на больших плитах врал (у плиты пола вершины только по углам, а углы цоколя
 * лежат за стенами помещения — снег шёл по всему полу вестибюля). Укрытия
 * считаются в шейдере по объёмам (`setSnowShelters` в `materials.ts`).
 *
 * Позиции квантуются к 2 см: вершины примитивов совпадают точно, а соседние
 * коробки (стена и парапет над ней) сливаются — и снег переходит с одной на
 * другую непрерывно, чего накладная плита не умела в принципе.
 */
function addSmoothNormals(geo: THREE.BufferGeometry): void {
  const pos = geo.attributes.position as THREE.BufferAttribute
  const nor = geo.attributes.normal as THREE.BufferAttribute | undefined
  if (!nor) return
  const n = pos.count
  const sum = new Map<number, [number, number, number]>()
  const keys = new Float64Array(n)
  const q = (v: number) => Math.round(v * 50) + 8192
  for (let i = 0; i < n; i++) {
    const k = (q(pos.getX(i)) * 16384 + q(pos.getY(i))) * 16384 + q(pos.getZ(i))
    keys[i] = k
    const s = sum.get(k)
    if (s) {
      s[0] += nor.getX(i)
      s[1] += nor.getY(i)
      s[2] += nor.getZ(i)
    } else {
      sum.set(k, [nor.getX(i), nor.getY(i), nor.getZ(i)])
    }
  }
  const smooth = new Float32Array(n * 3)
  for (let i = 0; i < n; i++) {
    const s = sum.get(keys[i])!
    const len = Math.hypot(s[0], s[1], s[2]) || 1
    smooth[i * 3] = s[0] / len
    smooth[i * 3 + 1] = s[1] / len
    smooth[i * 3 + 2] = s[2] / len
  }
  geo.setAttribute('aSmooth', new THREE.BufferAttribute(smooth, 3))
}
