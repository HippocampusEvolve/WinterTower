/**
 * shell.ts — оболочка мира: экран входа, он же пауза.
 *
 * Одинакова во всех мирах find-the-end.fun и переносится в новый мир копией
 * вместе с блоком «ОБОЛОЧКА МИРА» из `index.html` (docs/games.md). Правило
 * простое: здесь только вход, пауза и выход — ни настроек, ни счётчиков,
 * ни списка клавиш.
 *
 * Выход на витрину кода не требует вовсе: и стрелка в углу, и тихая ссылка
 * под кнопкой — обычные `<a>` в разметке. Отсюда только класс `paused` на
 * `body`, по которому стрелка и появляется.
 */

export interface Shell {
  /** Показать экран: до первого входа и на каждой паузе. */
  open(): void
  /** Убрать экран: игрок в мире. */
  close(): void
}

export function createShell(onEnter: () => void): Shell {
  const gate = document.getElementById('gate')!
  const button = document.getElementById('enter') as HTMLButtonElement

  button.addEventListener('click', onEnter)

  return {
    open() {
      gate.classList.remove('hidden')
      document.body.classList.add('paused')
    },
    close() {
      gate.classList.add('hidden')
      document.body.classList.remove('paused')
      // После первого входа кнопка зовёт не в мир, а обратно в мир.
      const resume = button.dataset.resume
      if (resume) button.textContent = resume
    },
  }
}
