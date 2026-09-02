/**
 * touch.ts — управление пальцем этого мира.
 *
 * Сам слой живёт в ядре (`world-core/core`, `TouchControls`): пальцы, оси,
 * поворот взгляда, кнопки как элементы, пропуск касаний по экранам оболочки.
 * Здесь остаётся только то, что про станцию: какие кнопки бывают, как они
 * выглядят и когда показываются. Раскладку в кадре им даёт CSS страницы по
 * этим же id.
 *
 * Никаких видимых джойстиков и здесь нет: палец на ЛЕВОЙ половине экрана ведёт
 * тело, палец на ПРАВОЙ поворачивает взгляд. Кнопки редкие и тонкие: прыжок
 * висит всегда, «рука» - когда ею есть что сделать, кнопки инструмента -
 * когда он в руках.
 */

import { TouchControls, touchForced, touchSupported } from 'world-core/core'
import type { Input, SmoothLook } from 'world-core/core'

export { touchForced, touchSupported }

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

export type Touch = ReturnType<typeof createTouch>

export function createTouch(input: Input, look: SmoothLook) {
  const touch = new TouchControls({
    input,
    look,
    // касание кнопок оболочки (экран входа, пауза, выход на витрину) не
    // глушим - иначе до `click` дело не дойдёт и из мира будет не выйти
    passThrough: 'button, a, #gate',
    buttons: [
      {
        id: 'tbJump',
        label: 'Прыгнуть',
        icon: ICONS.jump,
        shown: true,
        // держим факт нажатия - фронт ловит само тело
        press: (down) => (input.touch.jump = down),
      },
      { id: 'tbAct', label: 'Взаимодействовать', icon: ICONS.act, press: (down) => down && input.pressAction() },
      // держать кнопку инструмента = держать ЛКМ/ПКМ: замахи цепочкой
      { id: 'tbTool1', label: 'Использовать инструмент', icon: ICONS.shovel, press: (down) => input.pressTool(1, down) },
      { id: 'tbTool2', label: 'Насыпать снег', icon: ICONS.build, press: (down) => input.pressTool(2, down) },
    ],
  })

  // Что уже стоит в DOM. Видимость приходит из кадра, а трогать разметку
  // шестьдесят раз в секунду, чтобы оставить её той же самой, незачем.
  let shownAction: boolean | undefined
  let shownTool: ToolKind | undefined

  return {
    get active() {
      return touch.active
    },

    /** Войти в мир: pointer lock тут не нужен, просто включаемся. */
    activate: () => touch.activate(),

    /**
     * Видимость контекстных кнопок - из кадра. `action` держит «руку»: она
     * появляется, только когда ей есть что сделать. Тот же принцип, что у
     * текстовой подсказки, но без единого слова в кадре.
     */
    setButtons(action: boolean, tool: ToolKind) {
      if (action !== shownAction) {
        shownAction = action
        touch.show('tbAct', action)
      }
      if (tool === shownTool) return
      shownTool = tool
      touch.show('tbTool1', !!tool)
      touch.show('tbTool2', tool === 'shovel')
      const label = tool === 'axe' ? 'Рубить топором' : 'Копать лопатой'
      if (tool) touch.setIcon('tbTool1', ICONS[tool], label)
      else touch.get('tbTool1')?.setAttribute('aria-label', label)
    },
  }
}
