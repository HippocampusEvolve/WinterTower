/**
 * gltfload.ts — общий загрузчик моделей.
 *
 * До лопаты станция стояла на одной кодовой геометрии, и это остаётся
 * правилом: модель заводится тогда, когда предмет кодом не выходит. Загрузчик
 * без Draco намеренно — единственная модель весит 93 КБ, сжатие сняло бы с неё
 * десятки килобайт, а декодер стоит около 250 КБ и грузится к каждому входу
 * в мир.
 *
 * Прогресс идёт через `DefaultLoadingManager`, поэтому модель попадает в ту же
 * полосу загрузки, что и текстуры, и мир не открывается раньше неё.
 */

import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'

let loader: GLTFLoader | null = null

export function gltf(): GLTFLoader {
  if (!loader) loader = new GLTFLoader()
  return loader
}
