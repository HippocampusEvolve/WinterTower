/**
 * loading.ts — полоса под кнопкой входа.
 *
 * Модуль обязан выполниться ДО того, как заработает `world/materials.ts`:
 * карты запрашиваются прямо при его разборе, и подписка, поставленная позже,
 * пропустила бы часть счёта. Отсюда правило: в `main.ts` этот импорт стоит
 * первым, раньше всего, что тянет за собой мир.
 *
 * Считает один общий `DefaultLoadingManager` — через него идут все загрузки
 * three, так что счётчик покрывает отделку мира целиком.
 *
 * Ждать здесь больше нечего, и это не упущение. Экран входа открыт с первой
 * секунды и мира не ждёт (см. `shell.ts`), а карты доезжают уже в открытый
 * мир. Полоса поэтому живёт под кнопкой ровно до первого кадра и там же тает —
 * окно короткое, но на слабой машине или холодном кэше оно видимо, и показать
 * в нём настоящие доли лучше, чем дышать вслепую. Прежние `whenLoaded`/`probe`
 * и двенадцатисекундный предохранитель к ним убраны: держать вход до последней
 * карты — ровно то, от чего мы ушли.
 */

import * as THREE from 'three'

const bar = document.getElementById('loadBar')
const fill = document.getElementById('loadFill')

THREE.DefaultLoadingManager.onProgress = (_url, loaded, total) => {
  if (!bar || !fill || !total) return
  bar.classList.add('known')
  fill.style.width = `${Math.min(1, loaded / total) * 100}%`
  bar.setAttribute('aria-valuemin', '0')
  bar.setAttribute('aria-valuemax', String(total))
  bar.setAttribute('aria-valuenow', String(loaded))
  bar.setAttribute('aria-valuetext', `${loaded} из ${total} ресурсов`)
}
