/**
 * atmosphere.ts — сердце проекта.
 *
 * Здесь живут ВСЕ настройки внешнего вида: палитра, туман, свет, постпроцессинг.
 * По разбору референса (docs/REFERENCE.md) именно этот файл делает ~50% похожести.
 * Магические числа больше нигде в проекте появляться не должны.
 */

import * as THREE from 'three'
import {
  BloomEffect,
  BrightnessContrastEffect,
  Effect,
  EffectComposer,
  EffectPass,
  HueSaturationEffect,
  NoiseEffect,
  NormalPass,
  RenderPass,
  SMAAEffect,
  SSAOEffect,
  ToneMappingEffect,
  ToneMappingMode,
  VignetteEffect,
  BlendFunction,
} from 'postprocessing'
import GUI from 'lil-gui'

/**
 * Палитра снята с reference/ref_01.png — в фазе 3 пересчитана по средним
 * значениям участков кадра, а не на глаз. Разница оказалась принципиальной:
 * глаз читал референс как «серо-голубой», пиксели показали жёсткий синий увод
 * вебкамеры (даже снег на плато там #3e738f, стена корпуса #579dc0 —
 * красного вдвое меньше синего). По яркости мы совпадали и раньше, весь
 * разрыв был по цветности: насыщенность кадра 0.15 против 0.53 у референса.
 *
 * Правило прежнее: холодная база и ровно 3-4 тёплых пятна
 * (lampCore, lampGlow, windowWarm). Контраст по температуре, не по яркости.
 */
export const PALETTE = {
  // Туман светлее замера с картинки: ACES съедает верх диапазона, и чтобы
  // на экране получилось референсное #7ec6e8, на вход надо подать светлее.
  fogFar: 0x99d3ec,
  fogMid: 0x8ccdea,
  skyTop: 0xa1d5ee,
  skyBottom: 0x79b3d0,
  // Снег на референсе идёт 0.54 от яркости тумана, то есть ТЕМНЕЕ скалы (0.66):
  // он лежит мокрым и затоптанным, а отвесный камень ловит светящееся небо.
  // У нас порядок был обратный, и от этого кадр читался «снег с чёрными швами».
  snowLit: 0xb0bcc2,
  snowShadow: 0x98a8b1,
  concrete: 0xb9c8ce,
  // Скала была почти чёрной, и это оказалось прямой ошибкой, а не стилем:
  // на референсе камень держит 0.66-0.75 от тумана на ЛЮБОЙ глубине, у нас
  // выходило 0.37. Мокрая скала в синий час тёмная относительно тумана,
  // но сам туман светится, и до чёрного камню очень далеко.
  rockDark: 0x65879d,
  rockLight: 0x9bbacb,
  metal: 0x6b7278, // тёмный металл в тени
  // Обмёрзший металл: лестницы, перила, мачты — читаются светлыми.
  // Поднят с 0x9aa6ad: после разрежения тумана лестница держала 0.458 от его
  // яркости при 0.539 у референса — туман перестал её высветлять за неё.
  metalFrost: 0xaeb9c0,
  // Лёд озера внизу. Темнее и синее снега: он не рассеивает свет, а отражает
  // небо зеркалом — и потому на просвет читается как провал, а не как поле.
  iceDark: 0x6f8fa6,
  iceLight: 0x93b0c0,

  lampCore: 0xffb066,
  lampGlow: 0xff7a2a,
  windowWarm: 0xf3a24c,
} as const

/** Всё, что крутится ползунками. Значения здесь — стартовая точка, подобранная под референс. */
export const SETTINGS = {
  // Туман. FogExp2: видимость падает как exp(-(d*x)^2).
  // 0.012 → купол на 70 м ещё читается силуэтом, на 130 м всё растворилось.
  // Подбирается по столбам-маркерам в testground: должно быть видно 4-5 штук из 7.
  //
  // 0.0098 — из замера против референса (фаза 6, зонд по материалам лучом).
  // При 0.012 весь дальний план сидел светлее картинки: скала за 50 м держала
  // 0.81 от яркости тумана при 0.77 у референса, стена комплекса 0.91 при 0.77.
  // Туман тянет всё к своей яркости, и на 60 м при 0.012 он подмешивался на 40%
  // вместо 29%. Ниже 0.008 опускать нельзя — покажется дальний край полотна.
  fogDensity: 0.0098,
  fogColor: PALETTE.fogMid,

  // Свет. Прямого солнца нет — основной источник это небо.
  // 2.1 хватало на пустой равнине, но на застроенной сцене бетон и снег
  // выбивало в белое: разница по яркости между стеной и туманом исчезала.
  // В фазе 4 стояло 0.8: при тогдашних размерах мира 1.25 выбивало бетон и снег
  // ЯРЧЕ тумана, а на референсе всё твёрдое темнее его (стена 0.74, снег 0.54).
  //
  // Фаза 3.7 вернула 1.25, и это не откат, а следствие пересчёта масштаба
  // в 3.6: мир стал вдвое ближе, тумана между камерой и станцией стало меньше,
  // и при 0.8 отношения провалились в стену 0.68 и снег 0.46. Перебор
  // 0.8/0.95/1.1/1.25 (замер лучом по материалам, журнал сессии 7) даёт при
  // 1.25 ровно мишени: стена 0.74, снег 0.54.
  skyLight: 1.25,
  // Отражение от снега снизу: поднимает тени, а не общую яркость. Поднят с 0.3
  // ради ближней скалы — она сидит в нижней части кадра, где её давит ещё и
  // виньетка, и по замеру держала 0.47 от тумана при 0.62 у референса.
  // Правильная ручка именно эта: ближний борт стоит в снегу и обязан ловить
  // от него отсвет, а `skyLight` поднял бы вместе с ним и без того светлый верх.
  bounceLight: 0.42,
  sunLight: 0.35, // еле заметный направленный, только чтобы формы читались
  sunAngle: 125, // градусы, откуда падает

  // Тонмаппинг. Работает только начиная с фазы 3: до неё композитор
  // проглатывал и ACES, и экспозицию (см. ExposureEffect ниже).
  exposure: 1.1,

  // Грейдинг. Насыщенность была -0.18 «чтобы обесцветить» — ровно наоборот:
  // референс синее нас втрое, и правильное направление показал замер, а не глаз.
  //
  // Но догонять референс по АБСОЛЮТНОМУ цвету тумана нельзя: синий там 246,
  // то есть вебкамера его почти срезала. Перебор честно вывел на 0.65/+0.16 —
  // числа сошлись до единиц, а кадр стал неоновым бирюзовым плакатом.
  // Держимся отношений (стена/снег/скала к туману), они сходятся и здесь.
  // 0.4 → 0.34 после того, как туман стал разрежённее: молоко подмешивалось
  // ко всему дальнему плану и работало обесцвечиванием. Замер по всему кадру:
  // насыщенность референса 0.534, у нас была 0.568.
  saturation: 0.375,
  contrast: -0.05,
  brightness: 0.06, // чуть поднять чёрное: в референсе черноты нет вовсе

  // Постпроцессинг
  bloom: 0.85, // ореолы вокруг фонарей
  bloomThreshold: 0.62, // порог: цепляет только тёплые источники, не снег

  // --- Контактное затенение ---------------------------------------------------
  // Главное, чего кадру не хватало против референса, и это не деталь геометрии:
  // без AO здание не касается земли, короб не касается крыши, дверной откос не
  // имеет глубины — всё выглядит наклеенным друг на друга. Прямых теней в
  // пасмурном тумане нет вовсе, и объём лепит только затенение в углах.
  //
  // Радиус в МЕТРАХ мира здесь не задаётся: у SSAO он в долях разрешения,
  // и работает ОБРАТНО ожидаемому — чем он меньше, тем затенение контактнее.
  // Перебор замером (доля затенённых пикселей кадра): 0.05 → 6.2%, 0.14 → 4.2%,
  // 0.30 → 1.8%. Широкий радиус не «усиливает тень», а размазывает её в
  // равномерную муть, которая после тонмаппинга уже не видна.
  ssao: 2.2,
  ssaoRadius: 0.06,
  // Дальше этого AO гаснет: за 45 м туман съедает контраст, и затенённые углы
  // там читались бы грязными пятнами в молоке — ровно тем, чего на референсе нет.
  ssaoDistance: 45,
  // 0.45 → 0.2 по замеру самого референса: там спад яркости тумана от центра
  // к левому краю всего 3% (195.5 против 190.9), а виньетка в 0.45 давала у нас
  // втрое больше. Держалась она не зря — но платила за это ближняя скала,
  // которая сидит ровно в затемняемом нижнем углу.
  vignette: 0.2,
  grain: 0.075, // зерно вебкамерного кадра: без него гладкий градиент читается вектором

  // --- Снег ------------------------------------------------------------------
  // Два слоя: крупные хлопья у камеры (движение) и мелкая крупа вдаль (взвесь).
  // Количество читается один раз при старте, ползунком не меняется.
  snowNear: 2200,
  snowFar: 6000,
  // 0.09 давало на экране мягкие кляксы по 6-7 пикселей: кадр читался
  // не снегопадом, а пылью на объективе. Хлопья должны быть мелкими и частыми.
  snowSize: 0.055,
  snowFall: 1.5, // м/с вниз; ветер сносит вбок и делает косую штриховку
  snowOpacity: 0.8,

  // --- Ветер -----------------------------------------------------------------
  // Один источник правды: по нему летит снег и по нему же дышит эмбиент.
  windSpeed: 5.0, // ровная составляющая, м/с
  windGust: 4.5, // добавка на порывах
  windAngle: 118, // градусы, откуда дует (в плане)

  // --- Ореолы у тёплых источников -------------------------------------------
  // Блум растит нимб вокруг пикселей лампы, но не рисует конус света в снегу.
  // Ореол — спрайт с радиальным градиентом: это рассеяние в тумане, а не свет.
  halo: 0.45,
  haloScale: 1.0,

  // --- Клубы тумана ------------------------------------------------------------
  // Непрозрачность одного клуба (haze.ts). Величина маленькая не по ошибке:
  // билборд шириной в полсотни метров при 0.1 уже заметно мутит полкадра,
  // а работать он должен на грани различимости — как сгущение, а не как облако.
  haze: 0.16,

  // --- Звук ------------------------------------------------------------------
  ambient: 0.35, // громкость ветра, 0 — тишина
}

/**
 * Слой «этого нет в геометрии кадра»: снег и ореолы.
 *
 * Появился вместе с SSAO и ровно из-за него. Затенение считается по буферу
 * нормалей, а он рисуется отдельным проходом, которому всё равно, прозрачен
 * материал или нет: плоское пятно отсвета перед дверью попадало туда обычной
 * горизонтальной поверхностью, и SSAO честно затенял под ней землю — в кадре
 * это был тёмный клин поперёк ступеней (`reference/shots/phase6_ssao_wedge.png`).
 * Та же история у снежинок: 8200 точек в буфере нормалей.
 *
 * Камера слой видит, проход нормалей — нет.
 */
export const NO_NORMALS_LAYER = 1

export type Atmosphere = ReturnType<typeof createAtmosphere>

/**
 * Экспозиция одним умножением.
 *
 * В three экспозиция живёт внутри тонмаппинга, а тонмаппинг применяется ТОЛЬКО
 * при рендере прямо на экран. Композитор рисует сцену в буфер — значит, с самой
 * первой фазы не работало ни то, ни другое: ползунок «экспозиция» не менял
 * ничего (проверено: 0.3 и 2.0 дают попиксельно одинаковый кадр), а вместо
 * плавного плеча ACES тёплые пятна просто упирались в потолок sRGB.
 * Поэтому обе ступени возвращаем руками, в правильном порядке: блум по HDR,
 * потом экспозиция, потом ACES, и только после этого грейдинг.
 */
class ExposureEffect extends Effect {
  constructor(exposure: number) {
    super(
      'Exposure',
      `uniform float exposure;
       void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
         outputColor = vec4(inputColor.rgb * exposure, inputColor.a);
       }`,
      { uniforms: new Map([['exposure', new THREE.Uniform(exposure)]]) },
    )
  }

  set exposure(v: number) {
    this.uniforms.get('exposure')!.value = v
  }
}

/** Вертикальный градиент небо→туман→снег, пропущенный через PMREM. Заменяет HDRI. */
function makeGradientEnvironment(renderer: THREE.WebGLRenderer): THREE.Texture {
  const c = document.createElement('canvas')
  c.width = 4
  c.height = 128
  const ctx = c.getContext('2d')!
  const g = ctx.createLinearGradient(0, 0, 0, 128)
  const hex = (n: number) => '#' + n.toString(16).padStart(6, '0')
  g.addColorStop(0.0, hex(PALETTE.skyTop))
  g.addColorStop(0.5, hex(PALETTE.fogFar))
  g.addColorStop(0.62, hex(PALETTE.fogMid))
  g.addColorStop(1.0, hex(PALETTE.skyBottom))
  ctx.fillStyle = g
  ctx.fillRect(0, 0, 4, 128)

  const tex = new THREE.CanvasTexture(c)
  tex.mapping = THREE.EquirectangularReflectionMapping
  tex.colorSpace = THREE.SRGBColorSpace

  const pmrem = new THREE.PMREMGenerator(renderer)
  const env = pmrem.fromEquirectangular(tex).texture
  pmrem.dispose()
  tex.dispose()
  return env
}

export function createAtmosphere(
  scene: THREE.Scene,
  camera: THREE.PerspectiveCamera,
  renderer: THREE.WebGLRenderer,
) {
  // --- Туман и фон ---------------------------------------------------------
  // Фон = цвет тумана, поэтому горизонта не существует: всё уходит в молоко.
  const fog = new THREE.FogExp2(SETTINGS.fogColor, SETTINGS.fogDensity)
  scene.fog = fog
  scene.background = new THREE.Color(SETTINGS.fogColor)

  // --- Окружение для отражений --------------------------------------------
  // Без environment map всё металлическое рендерится чёрным — а чёрного в кадре быть не должно.
  // Вместо HDRI берём градиент небо→снег: этого хватает, файлов качать не надо.
  scene.environment = makeGradientEnvironment(renderer)

  // --- Свет ----------------------------------------------------------------
  const sky = new THREE.HemisphereLight(PALETTE.skyTop, PALETTE.skyBottom, SETTINGS.skyLight)
  scene.add(sky)

  // Отражение от снега. Настройка была объявлена ещё в фазе 1, но света под ней
  // не стояло — и тени уходили в почти чёрный сине-зелёный, которого в референсе
  // нет вовсе: там самая тёмная скала это #4b8aad, светлее середины нашей гаммы.
  // Снег внизу переотражает почти всё, что на него падает, и поднимает низ кадра.
  const bounce = new THREE.HemisphereLight(PALETTE.snowShadow, PALETTE.snowLit, SETTINGS.bounceLight)
  scene.add(bounce)

  const sun = new THREE.DirectionalLight(PALETTE.fogFar, SETTINGS.sunLight)
  sun.castShadow = false // теней в пасмурном тумане практически нет
  scene.add(sun)

  const placeSun = () => {
    const a = THREE.MathUtils.degToRad(SETTINGS.sunAngle)
    sun.position.set(Math.cos(a) * 60, 45, Math.sin(a) * 60)
  }
  placeSun()

  // --- Постпроцессинг ------------------------------------------------------
  // Тонмаппинг рендерера выключен намеренно: сцена уходит в буфер композитора,
  // где он всё равно не срабатывает. Экспозиция и ACES стоят в цепочке эффектов.
  renderer.toneMapping = THREE.NoToneMapping

  const composer = new EffectComposer(renderer, { frameBufferType: THREE.HalfFloatType })
  composer.addPass(new RenderPass(scene, camera))

  // Нормали сцены отдельным проходом — их читает SSAO. Проход стоит сразу за
  // рендером и ДО любого эффекта: он рисует сцену повторно и обязан видеть тот
  // же буфер глубины, что и основной проход.
  const normalPass = new NormalPass(scene, camera)
  // Снег и ореолы из буфера нормалей исключаются: см. NO_NORMALS_LAYER.
  // Слой гасится на камере только на время этого прохода — своей камеры
  // у NormalPass нет, он рисует той же.
  camera.layers.enable(NO_NORMALS_LAYER)
  const renderNormals = normalPass.render.bind(normalPass)
  normalPass.render = (...args: Parameters<typeof renderNormals>) => {
    camera.layers.disable(NO_NORMALS_LAYER)
    renderNormals(...args)
    camera.layers.enable(NO_NORMALS_LAYER)
  }
  composer.addPass(normalPass)

  composer.addPass(new EffectPass(camera, new SMAAEffect()))

  const ssao = new SSAOEffect(camera, normalPass.texture, {
    blendFunction: BlendFunction.MULTIPLY,
    samples: 16,
    rings: 7,
    radius: SETTINGS.ssaoRadius,
    intensity: SETTINGS.ssao,
    // Затенение уходит в синеву, а не в чёрное. Это не украшательство:
    // главное правило палитры — черноты в кадре нет вовсе, самое тёмное место
    // референса всё ещё светлее половины тумана (`REFERENCE.md` 2.2).
    // С чёрным AO углы служебного корпуса первыми же и провалились бы.
    color: new THREE.Color(PALETTE.rockDark),
    worldDistanceThreshold: SETTINGS.ssaoDistance,
    worldDistanceFalloff: 20,
    // Порог близости в МЕТРАХ: до него затенение работает в полную силу.
    // По умолчанию 0.4 — рассчитано на сцену из мебели, а у нас затеняются
    // стыки стен с цоколем, это метр с лишним; при 0.4 AO гасло всюду, кроме
    // самых узких щелей (1.2% затенённых пикселей кадра).
    // Но и разгонять его нельзя: при 6 м SSAO перестаёт быть контактным и
    // рисует ложную тень целым клином поперёк ступеней и стены — видно на
    // `reference/shots/phase6_ssao_wedge.png`. 1.2 м — рабочая середина.
    worldProximityThreshold: 1.2,
    worldProximityFalloff: 0.6,
    // Влияние яркости — 0.05, почти отключено, и это не произвол. По умолчанию
    // здесь 0.7: AO гасится на светлых пикселях, чтобы не пачкать засветы.
    // Наша сцена светлая ЦЕЛИКОМ (самое тёмное место — половина яркости тумана),
    // поэтому при 0.6 затенение гасилось везде: замер разницы кадров с AO и без
    // давал 1.3 из 255 при интенсивности 4 — то есть эффекта не было вовсе.
    luminanceInfluence: 0.05,
    bias: 0.03,
    fade: 0.02,
  })

  const bloom = new BloomEffect({
    intensity: SETTINGS.bloom,
    luminanceThreshold: SETTINGS.bloomThreshold,
    luminanceSmoothing: 0.3,
    mipmapBlur: true,
    radius: 0.7,
  })
  const exposure = new ExposureEffect(SETTINGS.exposure)
  const tone = new ToneMappingEffect({ mode: ToneMappingMode.ACES_FILMIC })
  const hueSat = new HueSaturationEffect({ saturation: SETTINGS.saturation })
  const briCon = new BrightnessContrastEffect({
    brightness: SETTINGS.brightness,
    contrast: SETTINGS.contrast,
  })
  const vignette = new VignetteEffect({ darkness: SETTINGS.vignette, offset: 0.32 })
  const noise = new NoiseEffect({ blendFunction: BlendFunction.OVERLAY, premultiply: true })
  noise.blendMode.opacity.value = SETTINGS.grain

  // Порядок важен: блум берёт HDR до экспозиции (порог не зависит от неё),
  // грейдинг и виньетка идут уже по картинке после ACES. SSAO — первым:
  // он часть освещения, а не грейдинга, и блум обязан видеть уже затенённые углы.
  composer.addPass(
    new EffectPass(camera, ssao, bloom, exposure, tone, hueSat, briCon, vignette, noise),
  )

  // Подписчики на apply(): снег, ореолы, звук живут вне этого файла, но их
  // ползунки должны стоять в той же панели. Три реальных потребителя — заводим.
  const listeners: Array<() => void> = []

  /** Прогнать SETTINGS в сцену. Вызывается ползунками GUI. */
  function apply() {
    fog.density = SETTINGS.fogDensity
    fog.color.set(SETTINGS.fogColor)
    ;(scene.background as THREE.Color).set(SETTINGS.fogColor)

    sky.intensity = SETTINGS.skyLight
    sky.groundColor.set(PALETTE.skyBottom)
    bounce.intensity = SETTINGS.bounceLight
    sun.intensity = SETTINGS.sunLight
    placeSun()

    exposure.exposure = SETTINGS.exposure

    bloom.intensity = SETTINGS.bloom
    bloom.luminanceMaterial.threshold = SETTINGS.bloomThreshold
    ssao.intensity = SETTINGS.ssao
    ssao.radius = SETTINGS.ssaoRadius
    // Дальность живёт на материале эффекта, а не на самом эффекте: у SSAOEffect
    // её принимает только конструктор.
    ssao.ssaoMaterial.worldDistanceThreshold = SETTINGS.ssaoDistance
    hueSat.saturation = SETTINGS.saturation
    briCon.brightness = SETTINGS.brightness
    briCon.contrast = SETTINGS.contrast
    vignette.darkness = SETTINGS.vignette
    noise.blendMode.opacity.value = SETTINGS.grain

    for (const fn of listeners) fn()
  }

  // --- Панель настройки ----------------------------------------------------
  const gui = new GUI({ title: 'Атмосфера  ·  G' })
  gui.domElement.style.display = 'none'

  const fFog = gui.addFolder('Туман')
  fFog.add(SETTINGS, 'fogDensity', 0, 0.06, 0.001).name('плотность').onChange(apply)
  fFog.addColor(SETTINGS, 'fogColor').name('цвет').onChange(apply)

  const fLight = gui.addFolder('Свет')
  fLight.add(SETTINGS, 'skyLight', 0, 5, 0.05).name('небо').onChange(apply)
  fLight.add(SETTINGS, 'bounceLight', 0, 3, 0.05).name('отсвет снега').onChange(apply)
  fLight.add(SETTINGS, 'sunLight', 0, 2, 0.01).name('солнце').onChange(apply)
  fLight.add(SETTINGS, 'sunAngle', 0, 360, 1).name('угол солнца').onChange(apply)
  fLight.add(SETTINGS, 'exposure', 0.1, 2, 0.01).name('экспозиция').onChange(apply)

  const fGrade = gui.addFolder('Грейдинг')
  fGrade.add(SETTINGS, 'saturation', -1, 0.5, 0.01).name('насыщенность').onChange(apply)
  fGrade.add(SETTINGS, 'contrast', -0.5, 0.5, 0.01).name('контраст').onChange(apply)
  fGrade.add(SETTINGS, 'brightness', -0.5, 0.5, 0.01).name('яркость').onChange(apply)

  const fPost = gui.addFolder('Постпроцессинг')
  fPost.add(SETTINGS, 'bloom', 0, 3, 0.01).name('блум').onChange(apply)
  fPost.add(SETTINGS, 'bloomThreshold', 0, 1, 0.01).name('порог блума').onChange(apply)
  fPost.add(SETTINGS, 'ssao', 0, 4, 0.05).name('затенение углов').onChange(apply)
  fPost.add(SETTINGS, 'ssaoRadius', 0.01, 0.5, 0.005).name('радиус затенения').onChange(apply)
  fPost.add(SETTINGS, 'ssaoDistance', 5, 120, 1).name('дальность затенения').onChange(apply)
  fPost.add(SETTINGS, 'vignette', 0, 1.5, 0.01).name('виньетка').onChange(apply)
  fPost.add(SETTINGS, 'grain', 0, 0.3, 0.005).name('зерно').onChange(apply)

  const fSnow = gui.addFolder('Снег и ветер')
  fSnow.add(SETTINGS, 'snowSize', 0.01, 0.3, 0.005).name('размер хлопьев').onChange(apply)
  fSnow.add(SETTINGS, 'snowOpacity', 0, 1, 0.01).name('плотность снега').onChange(apply)
  fSnow.add(SETTINGS, 'snowFall', 0.2, 6, 0.1).name('скорость падения').onChange(apply)
  fSnow.add(SETTINGS, 'windSpeed', 0, 20, 0.1).name('ветер').onChange(apply)
  fSnow.add(SETTINGS, 'windGust', 0, 20, 0.1).name('порывы').onChange(apply)
  fSnow.add(SETTINGS, 'windAngle', 0, 360, 1).name('направление ветра').onChange(apply)

  const fWarm = gui.addFolder('Тёплые источники')
  fFog.add(SETTINGS, 'haze', 0, 0.4, 0.005).name('клубы').onChange(apply)

  fWarm.add(SETTINGS, 'halo', 0, 2, 0.01).name('ореолы').onChange(apply)
  fWarm.add(SETTINGS, 'haloScale', 0.2, 3, 0.05).name('размер ореолов').onChange(apply)
  fWarm.add(SETTINGS, 'ambient', 0, 1, 0.01).name('громкость ветра').onChange(apply)

  gui.add(
    {
      печать: () => console.log(JSON.stringify(SETTINGS, null, 2)),
    },
    'печать',
  ).name('вывести настройки в консоль')

  function toggleGui() {
    const el = gui.domElement
    el.style.display = el.style.display === 'none' ? '' : 'none'
  }

  apply()

  /** Подписаться на изменение настроек ползунком. Вызывается сразу же. */
  function onApply(fn: () => void) {
    listeners.push(fn)
    fn()
  }

  return { composer, gui, toggleGui, apply, onApply, sun, sky, fog }
}
