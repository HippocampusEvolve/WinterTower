/**
 * wind.ts — ветер сцены. Один источник правды на всех потребителей:
 * по нему летит снег и по нему же дышит шум эмбиента. Если развести их
 * по отдельным генераторам, порыв будет слышен и виден в разное время —
 * и связь между картинкой и звуком рассыпается.
 *
 * Настройки (сила, порывы, направление) живут в SETTINGS, здесь только форма порыва.
 */

import * as THREE from 'three'
import { SETTINGS } from './atmosphere'

export type Wind = ReturnType<typeof createWind>

export function createWind() {
  /** Горизонтальная скорость, м/с. Читают снег и звук. */
  const vec = new THREE.Vector3()
  let time = 0
  /** 0..1 — насколько сейчас сильный порыв. Ею модулируется громкость. */
  let gust = 0

  return {
    vec,
    get gust() {
      return gust
    },

    update(dt: number) {
      time += dt

      // Три несоизмеримые частоты: порыв не повторяется ни на глаз, ни на слух.
      // Одна синусоида читается как качели, две — как биение.
      const n =
        Math.sin(time * 0.19) * 0.55 +
        Math.sin(time * 0.47 + 1.7) * 0.3 +
        Math.sin(time * 1.13 + 0.4) * 0.15
      gust = THREE.MathUtils.clamp(0.5 + 0.5 * n, 0, 1)

      // Направление гуляет на ±14°: снег, летящий строго по прямой, читается дождём.
      const a = THREE.MathUtils.degToRad(SETTINGS.windAngle + Math.sin(time * 0.11) * 14)
      const speed = SETTINGS.windSpeed + SETTINGS.windGust * gust
      vec.set(-Math.sin(a) * speed, 0, -Math.cos(a) * speed)
    },
  }
}
