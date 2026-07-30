/**
 * hands/index.ts — руки: что игрок держит, чем машет и во что попадает.
 *
 * Слой собирает вместе четыре независимые части: риг рук (`viewmodel.ts`),
 * механику замаха (`tool.ts`), сами инструменты (`shovel.ts`, `axe.ts`) и звук
 * (`sfx.ts`). Здесь же — единственное место, где они встречаются с миром.
 *
 * Правило, ради которого всё разделено: **инструмент не знает, во что попал.**
 * Замах доходит до кадра контакта и спрашивает «есть ли тут материя?». Отвечает
 * луч из камеры, и он же говорит, какая именно: по материалу решается и звук,
 * и цвет крошки. Поэтому новая цель под топор (наледь, ящик, снежный нанос)
 * не требует правок ни в топоре, ни в риге — только строчки в таблице MATERIAL.
 *
 * Правок мира пока нет: удар даёт звук, крошку и отдачу, но геометрию не меняет.
 * Точка, куда это встроится, помечена в `strike` — там уже известны и материал,
 * и точка, и нормаль.
 */

import * as THREE from 'three'
import { MAT } from '../world/materials'
import { createViewModel, type ViewBody } from './viewmodel'
import { Shovel, type ShovelStroke } from './shovel'
import { Axe } from './axe'
import { createSfx, type Material } from './sfx'
import type { Look } from '../look'

/**
 * Докуда дотягивается инструмент, м. Дальше замах уходит в воздух.
 *
 * Число игровое, а не анатомическое: рука с лопатой это метра полтора. Но глаз
 * стоит в 1.7 м над землёй, и чтобы ударить в пол перед собой, луч должен
 * пройти по диагонали — при 2.4 м работать получалось только глядя почти
 * вертикально вниз. 3.4 — та же величина, что в Snowfall, и там она подобрана
 * ровно по этой причине.
 */
const REACH = 3.4
/** С какого расстояния F берёт лежащий инструмент, м. */
const PICKUP = 2.2

/**
 * Материал поверхности по материалу меша. Ссылочное сравнение, а не имена:
 * материалы в `world/materials.ts` заводятся один раз и переиспользуются,
 * так что ссылка — самый дешёвый и самый надёжный ключ.
 */
function materialTable(): Map<THREE.Material, Material> {
  const t = new Map<THREE.Material, Material>()
  const put = (m: THREE.Material | THREE.Material[] | undefined, kind: Material) => {
    if (!m) return
    for (const one of Array.isArray(m) ? m : [m]) t.set(one, kind)
  }

  put(MAT.snow, 'snow')
  put(MAT.ground, 'snow')
  put(MAT.ice, 'ice')
  put(MAT.icicle, 'ice')
  put(MAT.puddle, 'ice')
  put(MAT.glass, 'ice')
  put(MAT.glassPale, 'ice')
  put(MAT.pane, 'ice')
  put(MAT.window, 'ice')
  put(MAT.rock, 'rock')
  put(MAT.rockDark, 'rock')
  put(MAT.concrete, 'rock')
  put(MAT.concreteDark, 'rock')
  put(MAT.wet, 'rock')
  put(MAT.grime, 'rock')
  put(MAT.metal, 'metal')
  put(MAT.deck, 'metal')
  put(MAT.metalDark, 'metal')
  put(MAT.rust, 'metal')
  put(MAT.wood, 'wood')
  put(MAT.boat, 'wood')
  return t
}

export type HandsBody = ViewBody & { position: THREE.Vector3 }

export type Hands = ReturnType<typeof createHands>

export function createHands(opts: {
  scene: THREE.Scene
  camera: THREE.PerspectiveCamera
  dom: HTMLElement
  look: Look
  /** Рельеф и постройки: по ним бьёт луч удара и по ним же ищется опора. */
  terrain: THREE.Object3D
  solid: THREE.Object3D
  sun: THREE.DirectionalLight
  heightAt: (x: number, z: number) => number
  /** Шина WebAudio: она появляется только после первого жеста пользователя. */
  getAudioBus: () => { ctx: AudioContext; out: GainNode } | null
  spawn: THREE.Vector3
  spawnYaw: number
}) {
  const { scene, camera, dom, look, terrain, solid, sun, heightAt } = opts

  const view = createViewModel(camera, sun, scene.environment)
  const sfx = createSfx(opts.getAudioBus)

  const shovel = new Shovel(scene, view)
  const axe = new Axe(scene, view)

  const MATERIAL = materialTable()
  const targets: THREE.Object3D[] = [terrain, solid]

  const ray = new THREE.Raycaster()
  ray.far = REACH
  const _dir = new THREE.Vector3()
  const _normal = new THREE.Vector3()
  const _spray = new THREE.Vector3()
  const _nm = new THREE.Matrix3()
  const _aim = new THREE.Vector3()

  const prompt = document.getElementById('prompt')

  // --- Опора под точкой ------------------------------------------------------

  const _down = new THREE.Raycaster(new THREE.Vector3(), new THREE.Vector3(0, -1, 0), 0, 6)

  /**
   * Высота, на которую встанет оставленный инструмент. Луч сверху, потому что
   * `heightAt` знает только рельеф: воткнутая на смотровой площадке лопата
   * иначе провалилась бы сквозь настил на скалу под ним.
   */
  function surfaceAt(x: number, z: number, fromY: number): number {
    _down.ray.origin.set(x, fromY + 2, z)
    const hit = _down.intersectObjects(targets, true)[0]
    return hit ? hit.point.y : heightAt(x, z)
  }

  // --- Инструменты в мире ----------------------------------------------------

  /**
   * Место под инструмент рядом со спавном: ищем ТВЁРДЫЙ ПОЛ на азимуте `bearing`,
   * разъезжаясь в стороны, пока не найдём.
   *
   * Без поиска не обойтись. Смотровая площадка узкая и обрывается с трёх сторон,
   * а жёстко заданное смещение попало ровно в вырез у её края: лопата уехала
   * на три метра вниз, на скалу под настилом, — с площадки её было не видно
   * и не достать. Годной считается только точка на высоте самой площадки.
   */
  function spot(bearing: number): { x: number; y: number; z: number } {
    const sp = opts.spawn
    for (const dA of [0, 0.3, -0.3, 0.6, -0.6, 0.9, -0.9, 1.2, -1.2, 1.6, -1.6, 2, -2]) {
      for (const r of [1.7, 1.3, 2.2]) {
        const a = bearing + dA
        // yaw смотрит по -Z, поэтому вперёд это (-sin, -cos); больший yaw — левее
        const x = sp.x - Math.sin(a) * r
        const z = sp.z - Math.cos(a) * r
        const y = surfaceAt(x, z, sp.y)
        if (Math.abs(y - sp.y) < 0.6) return { x, y, z }
      }
    }
    return { x: sp.x, y: sp.y, z: sp.z } // площадки нет вовсе — кладём под ноги
  }

  // Стоят так, как их оставил тот, кто работал здесь до игрока: по разные
  // стороны от выхода на площадку, в паре шагов и в поле зрения при спавне.
  {
    const s = spot(opts.spawnYaw - 0.9) // справа от взгляда
    shovel.place(s.x, s.y, s.z, opts.spawnYaw + 2.2)
    const a = spot(opts.spawnYaw + 0.9) // слева
    axe.place(a.x, a.y, a.z, opts.spawnYaw - 0.6)
  }

  // --- Ввод ------------------------------------------------------------------

  let digHeld = false
  let buildHeld = false
  let chopHeld = false
  let hintT = 0 // сек показа подсказки после взятия инструмента

  const locked = () => document.pointerLockElement !== null

  dom.addEventListener('mousedown', (e) => {
    if (!locked()) return
    if (e.button === 0) {
      if (shovel.held) digHeld = true
      else if (axe.held) chopHeld = true
    } else if (e.button === 2 && shovel.held) buildHeld = true
  })
  addEventListener('mouseup', (e) => {
    if (e.button === 0) {
      digHeld = false
      chopHeld = false
    } else if (e.button === 2) buildHeld = false
  })
  addEventListener('blur', () => {
    digHeld = buildHeld = chopHeld = false
  })
  dom.addEventListener('contextmenu', (e) => e.preventDefault())

  /** Что возьмёт F: ближайший К ПРИЦЕЛУ инструмент в пределах вытянутой руки. */
  function handTarget(): Shovel | Axe | null {
    if (shovel.held || axe.held) return null
    camera.getWorldDirection(_dir)
    let best: Shovel | Axe | null = null
    let bestDot = 0.55 // ниже — это уже «не смотрю на него»
    for (const tool of [shovel, axe]) {
      _aim.copy(tool.pos)
      _aim.y += 0.45 // целимся в черенок, а не в остриё у самой земли
      _aim.sub(camera.position)
      if (_aim.lengthSq() > PICKUP * PICKUP) continue
      const dot = _aim.normalize().dot(_dir)
      if (dot > bestDot) {
        bestDot = dot
        best = tool
      }
    }
    return best
  }

  /** F — контекстное действие: взять по прицелу или воткнуть то, что в руках. */
  function handAction(playerPos: THREE.Vector3) {
    const target = handTarget()
    if (target) {
      target.take()
      sfx.take()
      hintT = 8
      return
    }

    const held = shovel.held ? shovel : axe.held ? axe : null
    if (!held || held.busy) return

    camera.getWorldDirection(_dir)
    const x = playerPos.x + _dir.x * 0.8
    const z = playerPos.z + _dir.z * 0.8
    held.plant(x, surfaceAt(x, z, playerPos.y), z, Math.atan2(_dir.x, _dir.z))
    sfx.plant()
  }

  addEventListener('keydown', (e) => {
    if (e.code === 'KeyF' && locked()) handAction(camera.position)
  })

  // --- Врезание --------------------------------------------------------------

  /**
   * Что под прицелом в момент контакта. Луч, а не физическая форма инструмента:
   * попадание должно совпадать с тем, куда игрок СМОТРИТ, — прицел в центре
   * кадра и есть обещание игре, а честная развёртка лезвия его только нарушит.
   */
  function strike(): { point: THREE.Vector3; normal: THREE.Vector3; material: Material } | null {
    camera.getWorldDirection(_dir)
    ray.set(camera.position, _dir)
    const hit = ray.intersectObjects(targets, true)[0]
    if (!hit) return null

    // нормаль грани — в мировые оси; без normalMatrix она врёт на всём,
    // что повёрнуто (а повёрнуто здесь почти всё: лестницы, кожухи, перила)
    if (hit.face) {
      _nm.getNormalMatrix(hit.object.matrixWorld)
      _normal.copy(hit.face.normal).applyMatrix3(_nm).normalize()
    } else {
      _normal.copy(_dir).negate()
    }

    const mesh = hit.object as THREE.Mesh
    // Рельеф — единственная поверхность без своего материала в таблице:
    // он один на весь гребень и покрыт снегом, значит снег и есть.
    const material = MATERIAL.get(mesh.material as THREE.Material) ?? 'snow'
    return { point: hit.point, normal: _normal, material }
  }

  function onShovelImpact(kind: ShovelStroke): boolean {
    const hit = strike()
    if (!hit) {
      sfx.whiff()
      return false
    }

    // ЗДЕСЬ появится правка мира: снежный нанос под лопатой должен убывать
    // (kind === 'dig') и нарастать (kind === 'build'). Пока — только отклик.
    if (kind === 'dig') sfx.dig(hit.material)
    else sfx.scoop()

    // При копке крошка летит на копающего и вверх, при укладке — от штыка вперёд.
    camera.getWorldDirection(_dir)
    _spray.copy(_dir).multiplyScalar(kind === 'dig' ? -0.7 : 0.5)
    _spray.y = kind === 'dig' ? 1.3 : 0.7
    shovel.spray(hit.point, _spray)
    return true
  }

  function onAxeImpact(): boolean {
    const hit = strike()
    if (!hit) {
      sfx.whiff()
      return false
    }

    // ЗДЕСЬ появятся цели рубки: наледь скалывается, доски ящика лопаются.
    sfx.chop(hit.material)
    // Осколки летят ОТ поверхности по её нормали, с добавкой вверх: так виден
    // и угол, под которым ударили, и то, что это скол, а не взрыв из точки.
    _spray.copy(hit.normal).multiplyScalar(1.6)
    _spray.y += 0.9
    axe.spray(hit.point, _spray)
    return true
  }

  // --- Кадр ------------------------------------------------------------------

  function update(dt: number, body: HandsBody) {
    if (shovel.held && (digHeld || buildHeld)) shovel.trySwing(digHeld ? 'dig' : 'build')
    shovel.update(dt, onShovelImpact)

    if (axe.held && chopHeld) axe.trySwing('chop')
    axe.update(dt, onAxeImpact)

    view.update(dt, body)

    if (hintT > 0) hintT -= dt
    updatePrompt()
  }

  function updatePrompt() {
    if (!prompt) return
    let text: string | null = null
    if (!locked()) text = null
    else if (shovel.held) text = hintT > 0 ? 'ЛКМ - копать · ПКМ - намыть · F - воткнуть' : null
    else if (axe.held) text = hintT > 0 ? 'ЛКМ - рубить · F - воткнуть' : null
    else {
      const t = handTarget()
      if (t === shovel) text = 'F - взять лопату'
      else if (t === axe) text = 'F - взять топор'
    }
    prompt.classList.toggle('show', text !== null)
    if (text) prompt.textContent = text
  }

  /** Приземление: руки проседают вместе с телом, взгляд клюёт вниз. */
  function land(impact: number) {
    view.land(impact)
    look.land(impact)
  }

  /**
   * Отдача накладывается на мировую камеру ровно на время рендера и снимается
   * сразу после. Держать её в ориентации нельзя: `look.ts` пересобирает
   * кватернион каждый кадр, а риг рук меряет по камере угловую скорость взгляда
   * и прочитал бы оставленную отдачу как рывок мыши.
   */
  function renderWorld(renderer: THREE.WebGLRenderer, drawWorld: () => void) {
    const pitch = shovel.punch.pitch + axe.punch.pitch
    const roll = shovel.punch.roll + axe.punch.roll
    camera.rotateX(pitch)
    camera.rotateZ(roll) // локальные оси: отдача не зависит от того, куда смотрим
    drawWorld()
    camera.rotateZ(-roll)
    camera.rotateX(-pitch)

    view.render(renderer) // руки — последним проходом, поверх мира и со своим depth
  }

  return {
    update,
    land,
    renderWorld,
    setSize: (w: number, h: number) => view.setSize(w, h),
    view,
    shovel,
    axe,
    sfx,
    /** Для отладки из консоли: во что смотрим и чем это считается. */
    probe: strike,
  }
}
