/**
 * loading.ts — заставка загрузки.
 *
 * Модуль обязан выполниться ДО того, как заработает `world/materials.ts`:
 * карты запрашиваются прямо при его разборе, и подписка, поставленная позже,
 * пропустила бы часть счёта. Отсюда правило: в `main.ts` этот импорт стоит
 * первым, раньше всего, что тянет за собой мир.
 *
 * Считает один общий `DefaultLoadingManager` — через него идут все загрузки
 * three, так что счётчик покрывает отделку мира целиком.
 */

import * as THREE from 'three'

const bar = document.getElementById('loadBar')
const fill = document.getElementById('loadFill')

// Полоса в index.html до этого момента «дышала» вслепую: доли известны только
// отсюда, когда бандл разобран и лоадеры three начали считать элементы.
THREE.DefaultLoadingManager.onProgress = (_url, loaded, total) => {
  if (!bar || !fill || !total) return
  bar.classList.add('known')
  fill.style.width = `${Math.min(1, loaded / total) * 100}%`
}

let ready = false
const waiting: (() => void)[] = []

function fire() {
  if (ready) return
  ready = true
  for (const fn of waiting.splice(0)) fn()
}

THREE.DefaultLoadingManager.onLoad = fire

// Предохранитель: битая или очень медленная сеть не должна держать заставку
// вечно. Материалы работают и без карт — на плоском цвете из палитры, — так
// что пустить игрока внутрь всё же лучше, чем оставить его перед полосой.
setTimeout(fire, 12000)

/** Вызвать, когда отделка мира загружена (или вышло время предохранителя). */
export function whenLoaded(fn: () => void): void {
  if (ready) fn()
  else waiting.push(fn)
}

/**
 * Проба пустой очередью. Если грузить нечего вовсе, `onLoad` сам по себе не
 * придёт никогда — пара itemStart/itemEnd дёргает его синхронно. Зовётся из
 * `main.ts`, когда мир уже собран: раньше очередь пуста просто потому, что
 * до карт дело ещё не дошло.
 */
export function probe(): void {
  THREE.DefaultLoadingManager.itemStart('probe')
  THREE.DefaultLoadingManager.itemEnd('probe')
}
