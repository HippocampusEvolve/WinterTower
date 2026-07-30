/**
 * ambient.ts — звук ветра. Процедурный, без файлов.
 *
 * Ветер — это шум, пропущенный через фильтры. Хватает трёх голосов:
 *   низ    — гул, ровная подложка, «за окном непогода»;
 *   середина — сам поток, лоупасс ходит по частоте вместе с порывом;
 *   свист  — узкий бандпасс, вылезает только на пике порыва, за него цепляется ухо.
 *
 * Порывы берутся из общего ветра (wind.ts) — того же, что несёт снег.
 * Слышимый порыв обязан совпадать с видимым, иначе звук читается фонограммой.
 *
 * Браузер не даёт создавать звук до жеста пользователя: старт вызывается
 * из клика по заставке (main.ts).
 */

import { SETTINGS } from './atmosphere'
import type { Wind } from './wind'

export type Ambient = ReturnType<typeof createAmbient>

/** Секунда розоватого шума. Белый звенит слишком «песочно» для ветра. */
function noiseBuffer(ctx: AudioContext, seconds = 4): AudioBuffer {
  const buf = ctx.createBuffer(1, ctx.sampleRate * seconds, ctx.sampleRate)
  const d = buf.getChannelData(0)
  let b0 = 0
  let b1 = 0
  let b2 = 0
  for (let i = 0; i < d.length; i++) {
    const w = Math.random() * 2 - 1
    b0 = 0.997 * b0 + w * 0.0555
    b1 = 0.963 * b1 + w * 0.075
    b2 = 0.57 * b2 + w * 0.153
    d[i] = (b0 + b1 + b2 + w * 0.1848) * 0.6
  }
  return buf
}

export function createAmbient(wind: Wind) {
  let ctx: AudioContext | null = null
  let master: GainNode
  let lowGain: GainNode
  let midGain: GainNode
  let whistleGain: GainNode
  let midFilter: BiquadFilterNode
  let whistleFilter: BiquadFilterNode
  // Шина разовых звуков: шаги, удары инструмента. Ветер идёт мимо неё, поэтому
  // приглушение «за стеной» на удары не распространяется — оно про поток воздуха.
  let sfx: GainNode
  let muted = false

  /** Запускается по первому жесту пользователя. Повторные вызовы безвредны. */
  function start() {
    if (ctx) {
      if (ctx.state === 'suspended') void ctx.resume()
      return
    }
    ctx = new AudioContext()
    const buf = noiseBuffer(ctx)

    const src = () => {
      const s = ctx!.createBufferSource()
      s.buffer = buf
      s.loop = true
      s.start()
      return s
    }

    master = ctx.createGain()
    master.gain.value = 0
    master.connect(ctx.destination)

    sfx = ctx.createGain()
    sfx.gain.value = 1
    sfx.connect(ctx.destination)

    // Гул
    const low = ctx.createBiquadFilter()
    low.type = 'lowpass'
    low.frequency.value = 160
    lowGain = ctx.createGain()
    lowGain.gain.value = 0.9
    src().connect(low).connect(lowGain).connect(master)

    // Поток
    midFilter = ctx.createBiquadFilter()
    midFilter.type = 'lowpass'
    midFilter.frequency.value = 500
    midFilter.Q.value = 0.7
    midGain = ctx.createGain()
    midGain.gain.value = 0.35
    src().connect(midFilter).connect(midGain).connect(master)

    // Свист на гранях и растяжках
    whistleFilter = ctx.createBiquadFilter()
    whistleFilter.type = 'bandpass'
    whistleFilter.frequency.value = 1150
    whistleFilter.Q.value = 6
    whistleGain = ctx.createGain()
    whistleGain.gain.value = 0
    src().connect(whistleFilter).connect(whistleGain).connect(master)

    // Мягкий вход: щелчок в начале слышен даже сквозь шум.
    master.gain.setTargetAtTime(SETTINGS.ambient, ctx.currentTime, 1.5)
  }

  /**
   * `indoors` — игрок под крышей (реестр помещений, `world/interior.ts`).
   *
   * Стена глушит не громкость, а верх спектра: за дверью остаётся гул и уходит
   * шелест. Поэтому приглушение сделано тремя разными числами, а не одним
   * множителем на мастер — общая громкость падает вдвое, поток срезается
   * фильтром втрое по частоте, свист пропадает совсем. Переход плавный
   * (те же `setTargetAtTime`), иначе дверной проём щёлкает при каждом шаге.
   */
  function update(_dt: number, indoors = false) {
    if (!ctx || ctx.state !== 'running') return
    const t = ctx.currentTime
    const g = wind.gust
    const inside = indoors ? 1 : 0

    // setTargetAtTime, а не присваивание: ступеньки параметра дают щелчки.
    master.gain.setTargetAtTime(muted ? 0 : SETTINGS.ambient * (1 - inside * 0.55), t, 0.3)
    midFilter.frequency.setTargetAtTime((380 + g * 700) * (1 - inside * 0.7), t, 0.4)
    midGain.gain.setTargetAtTime((0.25 + g * 0.5) * (1 - inside * 0.5), t, 0.4)
    // Свист живёт только на верхушке порыва: степень 3 срезает середину.
    whistleGain.gain.setTargetAtTime(Math.pow(g, 3) * 0.28 * (1 - inside * 0.85), t, 0.5)
    whistleFilter.frequency.setTargetAtTime(950 + g * 500, t, 0.6)
  }

  /** Заглушить/вернуть звук. Горячей клавиши нет: из консоли — `wt.ambient.toggle()`. */
  function toggle() {
    muted = !muted
    if (ctx) sfx.gain.setTargetAtTime(muted ? 0 : 1, ctx.currentTime, 0.05)
    return !muted
  }

  return {
    start,
    update,
    toggle,
    /**
     * Контекст и шина для разовых звуков (`hands/sfx.ts`). Второй AudioContext
     * заводить нельзя: браузер держит на каждый отдельный аудиопоток, а к жесту
     * пользователя привязан только этот.
     */
    get bus(): { ctx: AudioContext; out: GainNode } | null {
      return ctx && ctx.state === 'running' ? { ctx, out: sfx } : null
    },
    /** Для отладки через window.wt: звук нельзя услышать из автотеста, но можно измерить. */
    get state() {
      return ctx ? ctx.state : 'не запущен'
    },
    get level() {
      return ctx ? +master.gain.value.toFixed(3) : 0
    },
    get whistle() {
      return ctx ? +whistleGain.gain.value.toFixed(3) : 0
    },
  }
}
