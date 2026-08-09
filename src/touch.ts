/**
 * touch.ts — управление пальцем: телефон и планшет.
 *
 * Никаких видимых джойстиков. Палец на ЛЕВОЙ половине экрана ведёт тело
 * (аналоговый вектор от точки касания; дальше увёл - бег), палец на ПРАВОЙ
 * поворачивает взгляд. Кнопки редкие и тонкие: прыжок висит всегда, «рука»
 * (аналог F) - только когда ею есть что сделать, кнопки инструмента - только
 * когда он в руках.
 *
 * Это не «версия для телефона», а проверка на прочность всего управления.
 * Клавиш на телефоне нет вообще, поэтому схема, работающая пальцем, тем более
 * работает мышью, - и ровно она нужна человеку, пришедшему из соцсети
 * (ROADMAP, «интуитивное управление вместо клавиш»).
 *
 * Интеграция узкая, и это намеренно: слой пишет аналоговые оси в `player.touch`
 * и поворачивает взгляд через `look.rotateBy`. Ни мира, ни инструментов он не
 * знает - что делает «рука» и что делают кнопки инструмента, решает тот, кто
 * его создал.
 *
 * Перенесён из Snowfall, где схема уже обкатана; расхождений два, оба от мира:
 * инструменты здесь лопата и топор (в Snowfall ещё и полено), а поворот взгляда
 * идёт в `rotateBy` с обеими осями сразу.
 */

import type { Player } from './player'
import type { Look } from './look'

const R = 52 // px полного хода пальца от точки касания до максимума скорости
const RUN_AT = 1.45 // во сколько R надо увести палец, чтобы перейти на бег
const DEAD = 7 // px мёртвой зоны - дрожь пальца не шевелит тело
const SENS = 0.0042 // рад/px взгляда (палец грубее мыши - чувствительность выше)

/** Иконки: только штрих, без заливок и подложек - белые и тихие. */
const ICONS = {
  // прыжок: стрелка отрывается от черты-земли
  jump: '<line x1="5" y1="20" x2="19" y2="20"/><polyline points="7.5 10.5 12 6 16.5 10.5"/><line x1="12" y1="6" x2="12" y2="16"/>',
  // рука-действие: точка в кольце - «взять/тронуть то, что перед тобой»
  act: '<circle cx="12" cy="12" r="7.5"/><circle cx="12" cy="12" r="0.8"/>',
  // лопата: черенок с перекладиной и совок
  shovel: '<path d="M9.5 3h5"/><line x1="12" y1="3" x2="12" y2="12.5"/><path d="M8.5 12.5h7v3.2a3.5 3.5 0 0 1-7 0z"/>',
  // намыть: горка снега
  build: '<path d="M5 18a7 7 0 0 1 14 0"/><line x1="3.5" y1="18" x2="20.5" y2="18"/>',
  // топор: топорище и клин лезвия
  axe: '<line x1="6" y1="20.5" x2="14.2" y2="7.2"/><path d="M13 4.5 18.5 9c-1.7 1.1-3.3 1.4-5.2 1L11.6 7.6c.4-1.1 .8-2.1 1.4-3.1z"/>',
} as const

/** Какой инструмент в руках: от этого зависят кнопки. */
export type ToolKind = 'shovel' | 'axe' | null

export type TouchOptions = {
  player: Player
  look: Look
  /** Аналог F: контекстное действие по месту. */
  onAction: () => void
  /** Кнопка инструмента: слот 1 - копать/рубить, слот 2 - намыть. Держать = бить. */
  onTool: (slot: 1 | 2, down: boolean) => void
}

export type Touch = ReturnType<typeof createTouch>

/**
 * Есть ли смысл заводить тач. `?touch` включает его на десктопе - посмотреть
 * раскладку кнопок, не доставая телефон; взгляд там мышью не водится, pointer
 * lock тач-режиму не нужен.
 */
export function touchSupported(): boolean {
  return (
    new URLSearchParams(location.search).has('touch') ||
    matchMedia('(pointer: coarse)').matches ||
    'ontouchstart' in window
  )
}

export function createTouch(opts: TouchOptions) {
  const { player, look, onAction, onTool } = opts

  let active = false
  let moveId: number | null = null // палец движения (левая половина)
  let lookId: number | null = null // палец взгляда (правая половина)
  let ox = 0
  let oy = 0
  let lx = 0
  let ly = 0

  // --- Кнопки ---------------------------------------------------------------
  const ui = document.createElement('div')
  ui.id = 'touchUI'
  document.body.appendChild(ui)

  function make(id: string, icon: keyof typeof ICONS): HTMLButtonElement {
    const b = document.createElement('button')
    b.id = id
    b.className = 'tbtn hide'
    b.innerHTML = `<svg viewBox="0 0 24 24">${ICONS[icon]}</svg>`
    ui.appendChild(b)
    return b
  }

  const bJump = make('tbJump', 'jump')
  const bAct = make('tbAct', 'act')
  const bTool1 = make('tbTool1', 'shovel')
  const bTool2 = make('tbTool2', 'build')
  let shownTool: ToolKind | undefined

  /** Нажатие кнопки: без прохода до канваса и без синтетики мыши. */
  function press(btn: HTMLButtonElement, fn: (down: boolean) => void) {
    btn.addEventListener(
      'touchstart',
      (e) => {
        e.preventDefault()
        e.stopPropagation()
        fn(true)
      },
      { passive: false },
    )
    const up = (e: Event) => {
      e.preventDefault()
      e.stopPropagation()
      fn(false)
    }
    btn.addEventListener('touchend', up, { passive: false })
    btn.addEventListener('touchcancel', up, { passive: false })
  }

  // Прыжок держим фактом нажатия: фронт ловит сам контроллер (jumpHeld).
  press(bJump, (down) => (player.touch.jump = down))
  press(bAct, (down) => down && onAction())
  press(bTool1, (down) => onTool(1, down))
  press(bTool2, (down) => onTool(2, down))

  // --- Пальцы на экране -----------------------------------------------------

  /**
   * Касания экранов оболочки (вход, пауза, выход на витрину) не глушим - иначе
   * до `click` дело не дойдёт и из мира будет не выйти.
   *
   * Проверок две, и вторая не лишняя. Попадание в узел (`closest`) держится на
   * том, что экран входа накрывает кадр целиком: стоит ему однажды перестать
   * это делать - и палец мимо него поведёт тело за спиной у остановленной игры.
   * Поэтому спрашиваем ещё и состояние оболочки напрямую: `body.paused` стоит,
   * пока игрок не вошёл в мир.
   */
  function skip(e: TouchEvent): boolean {
    if (!active) return true
    if (document.body.classList.contains('paused')) return true
    const t = e.target as Element | null
    return !!(t && t.closest && t.closest('button, a, #gate'))
  }

  function onStart(e: TouchEvent) {
    if (skip(e)) return
    e.preventDefault()
    for (const t of Array.from(e.changedTouches)) {
      if (t.clientX < innerWidth * 0.5) {
        if (moveId !== null) continue
        moveId = t.identifier
        ox = t.clientX
        oy = t.clientY
      } else {
        if (lookId !== null) continue
        lookId = t.identifier
        lx = t.clientX
        ly = t.clientY
      }
    }
  }

  function onMove(e: TouchEvent) {
    if (skip(e)) return
    e.preventDefault()
    const p = player.touch
    for (const t of Array.from(e.changedTouches)) {
      if (t.identifier === moveId) {
        const dx = t.clientX - ox
        const dy = t.clientY - oy
        const len = Math.hypot(dx, dy)
        if (len < DEAD) {
          p.f = p.r = 0
          p.run = false
          continue
        }
        p.r = Math.max(-1, Math.min(1, dx / R))
        p.f = Math.max(-1, Math.min(1, -dy / R))
        p.run = len > R * RUN_AT && p.f > 0.5 // бег - только уверенно вперёд
      } else if (t.identifier === lookId) {
        look.rotateBy(-(t.clientX - lx) * SENS, -(t.clientY - ly) * SENS)
        lx = t.clientX
        ly = t.clientY
      }
    }
  }

  function onEnd(e: TouchEvent) {
    if (skip(e)) return
    e.preventDefault()
    const p = player.touch
    for (const t of Array.from(e.changedTouches)) {
      if (t.identifier === moveId) {
        moveId = null
        p.f = p.r = 0
        p.run = false
      } else if (t.identifier === lookId) {
        lookId = null
      }
    }
  }

  const listen = { passive: false } as const
  addEventListener('touchstart', onStart, listen)
  addEventListener('touchmove', onMove, listen)
  addEventListener('touchend', onEnd, listen)
  addEventListener('touchcancel', onEnd, listen)

  return {
    get active() {
      return active
    },

    /** Войти в мир: pointer lock тут не нужен, просто включаемся. */
    activate() {
      if (active) return
      active = true
      look.setTouchMode(true)
      ui.classList.add('on')
      bJump.classList.remove('hide')
      document.body.classList.add('touch-mode')
    },

    /**
     * Видимость контекстных кнопок - из кадра. `action` держит «руку»: она
     * появляется, только когда ей есть что сделать. Это тот же принцип, что у
     * текстовой подсказки, но без единого слова в кадре.
     */
    setButtons(action: boolean, tool: ToolKind) {
      bAct.classList.toggle('hide', !action)
      if (tool === shownTool) return
      shownTool = tool
      bTool1.classList.toggle('hide', !tool)
      bTool2.classList.toggle('hide', tool !== 'shovel')
      if (tool) bTool1.querySelector('svg')!.innerHTML = ICONS[tool]
    },
  }
}
