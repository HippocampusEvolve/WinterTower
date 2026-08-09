/**
 * hands/sfx.ts — разовые звуки: шаги, приземление, работа инструментом.
 *
 * Всё синтезируется из шума и синусов, файлов нет — как и у ветра (`ambient.ts`),
 * контекст берётся оттуда же. Библиотека сэмплов для десятка коротких ударов
 * весила бы больше, чем весь остальной проект, и всё равно повторялась бы
 * на слух: здесь каждый удар чуть другой, потому что собран заново.
 *
 * Материал слышен по трём вещам, и они важнее громкости:
 *   * АТАКА. У снега её нет вовсе (мягкое сминание), у льда и металла она
 *     мгновенная, у дерева между ними.
 *   * ВЕРХ СПЕКТРА. Снег глушит его наглухо, лёд наоборот звенит.
 *   * ХВОСТ. Металл гудит после удара, снег умирает сразу.
 */

type Bus = { ctx: AudioContext; out: GainNode }

/** Во что пришёлся удар или на чём стоит нога. */
export type Material = 'snow' | 'ice' | 'rock' | 'metal' | 'wood'

export type Sfx = ReturnType<typeof createSfx>

export function createSfx(getBus: () => Bus | null) {
  let noise: AudioBuffer | null = null
  let noiseCtx: AudioContext | null = null

  /** Секунда белого шума. Общий буфер на все звуки: он же основа и хруста, и свиста. */
  function noiseBuf(ctx: AudioContext): AudioBuffer {
    if (noise && noiseCtx === ctx) return noise
    const buf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate)
    const d = buf.getChannelData(0)
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1
    noise = buf
    noiseCtx = ctx
    return buf
  }

  type GrainOpts = {
    at?: number // задержка от «сейчас», с
    dur?: number
    /** Тип фильтра и его частоты: [начальная, конечная]. */
    type?: BiquadFilterType
    freq: number
    to?: number
    q?: number
    gain: number
    attack?: number
    rate?: number
  }

  /** Шумовая пачка через фильтр: основа хруста, свиста, скрежета. */
  function grain(bus: Bus, o: GrainOpts) {
    const { ctx } = bus
    const t = ctx.currentTime + (o.at ?? 0) + 0.005
    const dur = o.dur ?? 0.16
    const src = ctx.createBufferSource()
    src.buffer = noiseBuf(ctx)
    src.playbackRate.value = o.rate ?? 1

    const f = ctx.createBiquadFilter()
    f.type = o.type ?? 'bandpass'
    f.frequency.setValueAtTime(o.freq, t)
    if (o.to) f.frequency.exponentialRampToValueAtTime(o.to, t + dur)
    f.Q.value = o.q ?? 1

    const g = ctx.createGain()
    const attack = o.attack ?? 0.012
    g.gain.setValueAtTime(0.0001, t)
    g.gain.linearRampToValueAtTime(o.gain, t + attack)
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur)

    src.connect(f).connect(g).connect(bus.out)
    src.start(t, Math.random() * 1.5, dur + 0.05)
  }

  /**
   * Синус с падающей частотой: вес удара, гул металла, глухой «уф».
   *
   * `attack` - не украшение, а сам материал. Раньше он был жёстко зашит в 12 мс
   * на все случаи, и это молча съедало главное различие: удар по льду и врез в
   * снег выходили с одинаковой атакой, хотя шапка файла обещает обратное. Слышно
   * это было как «все удары на одно лицо», а видно стало только счётом.
   */
  function tone(bus: Bus, freq: number, to: number, gain: number, dur: number, at = 0, attack = 0.012) {
    const { ctx } = bus
    const t = ctx.currentTime + at + 0.005
    const o = ctx.createOscillator()
    o.type = 'sine'
    o.frequency.setValueAtTime(freq, t)
    o.frequency.exponentialRampToValueAtTime(to, t + dur)
    const g = ctx.createGain()
    g.gain.setValueAtTime(0.0001, t)
    g.gain.linearRampToValueAtTime(gain, t + Math.min(attack, dur * 0.9))
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur)
    o.connect(g).connect(bus.out)
    o.start(t)
    o.stop(t + dur + 0.05)
  }

  /**
   * Модальный синтез: тело, звенящее на своих собственных частотах.
   *
   * Один синус - это «бум» вообще, без породы. Настоящий предмет после удара
   * звучит набором мод, и их отношения - его подпись: у деревянного бруска они
   * идут как 1 : 2.76 : 5.40 (изгибные моды свободного стержня), у железа моды
   * ближе к целым кратным и держатся куда дольше. Двадцать строк кода дают то,
   * ради чего обычно заводят библиотеку сэмплов.
   *
   * `decays` - время жизни каждой моды в долях от первой: высокие моды гаснут
   * первыми, поэтому удар «темнеет» на глазах, а не просто затихает.
   */
  function modal(
    bus: Bus,
    o: { freq: number; ratios: number[]; gains: number[]; decays: number[]; dur: number; gain: number; attack?: number; at?: number }
  ) {
    const { ctx } = bus
    const t = ctx.currentTime + (o.at ?? 0) + 0.005
    const attack = o.attack ?? 0.002
    for (let i = 0; i < o.ratios.length; i++) {
      const dur = o.dur * o.decays[i]
      const osc = ctx.createOscillator()
      osc.type = 'sine'
      // Лёгкая расстройка: идеально кратные моды звучат электронным органом,
      // у настоящего тела они всегда чуть врозь.
      osc.frequency.value = o.freq * o.ratios[i] * (1 + (Math.random() - 0.5) * 0.012)
      const g = ctx.createGain()
      g.gain.setValueAtTime(0.0001, t)
      g.gain.linearRampToValueAtTime(o.gain * o.gains[i], t + attack)
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur)
      osc.connect(g).connect(bus.out)
      osc.start(t)
      osc.stop(t + dur + 0.05)
    }
  }

  // --- Шаги ------------------------------------------------------------------

  /**
   * Снег скрипит зёрнами, решётка звенит. Оба звука — россыпь коротких пачек
   * с разными фильтрами, потому что шаг это не один щелчок, а несколько
   * микрособытий подряд: касание, сминание, перенос веса.
   */
  function footstep(running: boolean, surface: 'snow' | 'deck') {
    const bus = getBus()
    if (!bus) return
    const loud = running ? 1.35 : 1

    if (surface === 'snow') {
      const grains = 4 + ((Math.random() * 3) | 0)
      for (let i = 0; i < grains; i++) {
        grain(bus, {
          at: i * 0.013 + Math.random() * 0.01,
          dur: 0.07,
          type: 'lowpass',
          freq: 700 + Math.random() * 700,
          q: 0.7,
          gain: 0.075 * loud * Math.pow(0.82, i) * (0.7 + Math.random() * 0.6),
          rate: 0.5 + Math.random() * 0.5,
        })
      }
      // Вес шага по снегу нарастает долго: нога тонет, а не бьёт. Живая запись
      // даёт здесь 26-30 мс, и на слух это разница между «иду по снегу» и
      // «стучу по снегу».
      tone(bus, 70, 42, 0.05 * loud, 0.11, 0, 0.026)
      return
    }

    // Решётчатый настил: сухой стук подошвы и короткий металлический призвук.
    grain(bus, { dur: 0.05, type: 'bandpass', freq: 1500, to: 700, q: 1.1, gain: 0.09 * loud, attack: 0.002 })
    grain(bus, {
      at: 0.01,
      dur: 0.13,
      type: 'bandpass',
      freq: 2600 + Math.random() * 900,
      q: 7,
      gain: 0.035 * loud,
      attack: 0.0015,
    })
    tone(bus, 96, 55, 0.06 * loud, 0.09, 0, 0.002)
  }

  /** Приземление: тот же материал, но тяжелее и с провалом в низ. */
  function land(surface: 'snow' | 'deck', strength: number) {
    const bus = getBus()
    if (!bus) return
    const k = Math.min(1.6, Math.abs(strength) / 8)
    if (surface === 'snow') {
      grain(bus, { dur: 0.22, type: 'lowpass', freq: 900, to: 300, q: 0.6, gain: 0.3 * k, attack: 0.02 })
      tone(bus, 62, 34, 0.26 * k, 0.28, 0, 0.03)
    } else {
      grain(bus, { dur: 0.09, type: 'bandpass', freq: 1300, to: 500, q: 1, gain: 0.26 * k, attack: 0.002 })
      grain(bus, { at: 0.005, dur: 0.34, type: 'bandpass', freq: 2200, q: 9, gain: 0.1 * k, attack: 0.0015 })
      tone(bus, 88, 40, 0.24 * k, 0.24, 0, 0.002)
    }
  }

  // --- Инструмент ------------------------------------------------------------

  /** Промах: только свист по воздуху. Общий на все инструменты. */
  function whiff() {
    const bus = getBus()
    if (!bus) return
    grain(bus, { dur: 0.18, type: 'bandpass', freq: 500, to: 1400, q: 1.4, gain: 0.06, attack: 0.06 })
  }

  /**
   * Врез лопаты. Вес нажима идёт длинной атакой и без свипа частоты: это
   * придавливание, а не удар, и именно этим копание отличается от рубки.
   */
  function dig(material: Material) {
    const bus = getBus()
    if (!bus) return

    if (material === 'snow') {
      grain(bus, { dur: 0.2, type: 'bandpass', freq: 700, to: 300, q: 0.7, gain: 0.34, attack: 0.035 })
      const grains = 5 + ((Math.random() * 4) | 0)
      for (let i = 0; i < grains; i++) {
        grain(bus, {
          at: 0.02 + i * 0.016 + Math.random() * 0.012,
          dur: 0.07,
          type: 'lowpass',
          freq: 520 + Math.random() * 500,
          q: 0.7,
          gain: 0.2 * Math.pow(0.87, i) * (0.7 + Math.random() * 0.5),
          rate: 0.45 + Math.random() * 0.6,
        })
      }
      // Вес нажима идёт длинной атакой: это придавливание, а не удар, и именно
      // этим копание отличается от рубки. У живой лопаты здесь 36-62 мс.
      tone(bus, 58, 44, 0.16, 0.24, 0, 0.04)
      return
    }
    // Штык о камень или железо: скрежет вместо хруста, и никакого веса —
    // лопата отскакивает, а не входит.
    //
    // Первым идёт короткий цок железа о камень - и он модальный, не шумовой.
    // У пачки шума своей атаки нет вовсе: пик приходится на случайное место
    // внутри неё, и отскок читался мягким шорохом, хотя задуман резким. Резкую
    // атаку может дать только то, у чего есть определённая форма волны.
    modal(bus, {
      freq: 3600,
      ratios: [1, 1.71],
      gains: [1, 0.45],
      decays: [1, 0.7],
      dur: 0.03,
      gain: 0.18,
      attack: 0.0004,
    })
    grain(bus, { dur: 0.13, type: 'bandpass', freq: 2400, to: 1100, q: 2.5, gain: 0.14, attack: 0.0015 })
    grain(bus, { at: 0.01, dur: 0.09, type: 'highpass', freq: 3000, q: 0.8, gain: 0.07, attack: 0.0015 })
  }

  /** Укладка снега: мягкий сброс и глухое похлопывание штыком. */
  function scoop() {
    const bus = getBus()
    if (!bus) return
    grain(bus, { dur: 0.28, type: 'lowpass', freq: 1300, to: 380, q: 0.6, gain: 0.32, attack: 0.03 })
    tone(bus, 95, 40, 0.2, 0.14, 0.1, 0.008)
  }

  /**
   * Удар топора. У каждого материала своя подпись, и разница между ними —
   * главное, что слышит игрок: по звуку понятно, попал он в наледь, в доску
   * или в скалу, даже не глядя на брызги.
   */
  function chop(material: Material) {
    const bus = getBus()
    if (!bus) return

    switch (material) {
      case 'ice':
        // Звонкий скол: мгновенная атака, высокий звон, россыпь осколков.
        grain(bus, { dur: 0.07, type: 'bandpass', freq: 3400, to: 1800, q: 3, gain: 0.3, attack: 0.001 })
        grain(bus, { at: 0.004, dur: 0.3, type: 'bandpass', freq: 5200, q: 12, gain: 0.12, attack: 0.001 })
        for (let i = 0; i < 4; i++) {
          grain(bus, {
            at: 0.05 + Math.random() * 0.16,
            dur: 0.06,
            type: 'bandpass',
            freq: 3000 + Math.random() * 3000,
            q: 8,
            gain: 0.05,
            attack: 0.001,
          })
        }
        tone(bus, 150, 90, 0.1, 0.1, 0, 0.0008)
        break

      case 'wood':
        // Сухой «тюк»: атака есть, но верх съеден древесиной, и остаётся корпус.
        // Корпус - модальный: у бруска моды идут 1 : 2.76 : 5.40, и именно это
        // отличает удар по бревну от удара вообще.
        grain(bus, { dur: 0.09, type: 'bandpass', freq: 1600, to: 600, q: 1.6, gain: 0.34, attack: 0.0015 })
        grain(bus, { at: 0.01, dur: 0.16, type: 'bandpass', freq: 380, q: 3.5, gain: 0.18, attack: 0.006 })
        modal(bus, {
          freq: 190,
          ratios: [1, 2.76, 5.4],
          gains: [1, 0.35, 0.12],
          decays: [1, 0.55, 0.3], // высокие моды гаснут первыми: удар темнеет
          dur: 0.22,
          gain: 0.14,
          attack: 0.002,
        })
        break

      case 'metal':
        // Гул: удар короткий, а хвост долгий — железо держит ноту. Моды почти
        // кратные и затухают медленно, поэтому железо и «звенит» после удара.
        grain(bus, { dur: 0.06, type: 'bandpass', freq: 2800, to: 1400, q: 2, gain: 0.26, attack: 0.0008 })
        modal(bus, {
          freq: 420,
          ratios: [1, 1.52, 2.98, 4.1],
          gains: [1, 0.5, 0.28, 0.14],
          decays: [1, 0.8, 0.6, 0.45],
          dur: 0.85,
          gain: 0.1,
          attack: 0.001,
        })
        break

      case 'rock':
        // Камень не звенит и не гудит: короткий тупой щелчок и пыль.
        grain(bus, { dur: 0.06, type: 'bandpass', freq: 2000, to: 900, q: 1.8, gain: 0.28, attack: 0.0008 })
        grain(bus, { at: 0.02, dur: 0.12, type: 'lowpass', freq: 1200, q: 0.7, gain: 0.1, attack: 0.01 })
        tone(bus, 110, 70, 0.12, 0.09, 0, 0.0015)
        break

      default:
        // Топор в снегу — почти беззвучен, и это честный ответ игроку: не то.
        grain(bus, { dur: 0.15, type: 'lowpass', freq: 700, to: 300, q: 0.6, gain: 0.16, attack: 0.03 })
        tone(bus, 60, 40, 0.1, 0.16, 0, 0.03)
    }
  }

  /** Взять инструмент: перехват черенка и короткий металлический тик. */
  function take() {
    const bus = getBus()
    if (!bus) return
    grain(bus, { dur: 0.1, type: 'bandpass', freq: 800, to: 400, q: 2, gain: 0.14, attack: 0.004 })
    grain(bus, { at: 0.05, dur: 0.09, type: 'bandpass', freq: 3100 + Math.random() * 600, q: 6, gain: 0.1, attack: 0.003 })
  }

  /** Воткнуть инструмент: одиночный глубокий врез в наст. */
  function plant() {
    dig('snow')
  }

  return { footstep, land, whiff, dig, scoop, chop, take, plant }
}
