/**
 * shell.ts — оболочка мира: экран входа, он же пауза.
 *
 * Одинакова во всех мирах find-the-end.fun и переносится в новый мир копией
 * вместе с блоком «ОБОЛОЧКА МИРА» из `index.html` (docs/games.md). Правило
 * простое: здесь только вход, пауза и выход — ни настроек, ни счётчиков,
 * ни списка клавиш.
 *
 * Экран этот НЕ ЖДЁТ МИРА и не принадлежит ему. Он нарисован разметкой и виден
 * с первой секунды; кнопки на нём живые сразу, потому что до прихода мира их
 * держит `boot.js`. Мир собирается за экраном и лишь забирает управление им,
 * когда встал на ноги, — вместе с тем, что успели нажать без него.
 *
 * Выход на витрину кода не требует вовсе: и стрелка в углу, и тихая ссылка
 * под кнопкой — обычные `<a>` в разметке. Отсюда только класс `paused` на
 * `body`, по которому стрелка и появляется.
 */

/** Что нажали, пока мир собирался. */
export interface Pressed {
  /** Событие нажатия «войти», если оно было: по нему видно, чем вошли. */
  enter: Event | null
  /** Нажимали ли «начать заново» (есть не во всех мирах). */
  reset: boolean
}

export interface Shell {
  /** Мир собран: экран переходит от `boot.js` к нему. Отдаёт то, что нажали. */
  ready(): Pressed
  /** Показать экран: на каждой паузе. До первого входа он и так открыт. */
  open(): void
  /** Убрать экран: игрок в мире. */
  close(): void
  /** Открыт ли экран сейчас. */
  isOpen(): boolean
}

interface Boot {
  ready(handlers?: { enter?: (ev: Event) => void; reset?: () => void }): Pressed
}

export function createShell(handlers: {
  onEnter: (ev: Event) => void
  onReset?: () => void
}): Shell {
  const gate = document.getElementById('gate')!
  const button = document.getElementById('enter') as HTMLButtonElement

  return {
    ready() {
      const boot = (window as Window & { __FTE_BOOT__?: Boot }).__FTE_BOOT__
      return (
        boot?.ready({ enter: handlers.onEnter, reset: handlers.onReset }) ?? {
          enter: null,
          reset: false,
        }
      )
    },
    open() {
      gate.inert = false
      gate.setAttribute('aria-hidden', 'false')
      gate.classList.remove('hidden')
      document.body.classList.add('paused')
      requestAnimationFrame(() => button.focus({ preventScroll: true }))
    },
    close() {
      gate.classList.add('hidden')
      gate.inert = true
      gate.setAttribute('aria-hidden', 'true')
      document.body.classList.remove('paused')
      // После первого входа кнопка зовёт не в мир, а обратно в мир.
      const resume = button.dataset.resume
      if (resume) button.textContent = resume
      document.body.tabIndex = -1
      document.body.focus({ preventScroll: true })
    },
    isOpen() {
      return !gate.classList.contains('hidden')
    },
  }
}
