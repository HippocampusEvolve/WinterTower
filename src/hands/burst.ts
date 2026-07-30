/**
 * hands/burst.ts — короткий фонтан частиц от удара инструмента.
 *
 * Снежная крошка из-под штыка, ледяная пыль от скола, щепа из-под топора.
 * Система одна, но цвет и физика у неё общие на весь экземпляр (щепа тяжелее
 * крошки и падает быстрее), поэтому каждому источнику заводится свой.
 *
 * Точки, а не спрайты: сотня прозрачных билбордов в кадре, где и так лежит
 * снегопад и туман, стоит дороже, чем даёт.
 */

import * as THREE from 'three'

type Particle = {
  x: number
  y: number
  z: number
  vx: number
  vy: number
  vz: number
  age: number
  ttl: number
}

export type BurstOptions = {
  /** Цвет строкой GLSL-компонент: «r, g, b» в линейном пространстве. */
  color?: string
  /** px·м — масштаб точки до деления на глубину. */
  size?: number
  gravity?: number
  drag?: number
  max?: number
}

const DEFAULTS: Required<BurstOptions> = {
  color: '0.78, 0.85, 0.92', // снежная крошка в синем часе
  size: 52,
  gravity: 7.5,
  drag: 1.6,
  max: 220,
}

export class Burst {
  private live: Particle[] = []
  private posArr: Float32Array
  private aArr: Float32Array
  private gravity: number
  private drag: number
  private max: number
  readonly points: THREE.Points

  constructor(scene: THREE.Object3D, opts: BurstOptions = {}) {
    const o = { ...DEFAULTS, ...opts }
    this.gravity = o.gravity
    this.drag = o.drag
    this.max = o.max
    this.posArr = new Float32Array(o.max * 3)
    this.aArr = new Float32Array(o.max)

    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(this.posArr, 3))
    geo.setAttribute('aAlpha', new THREE.BufferAttribute(this.aArr, 1))
    geo.setDrawRange(0, 0)

    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      uniforms: { uPR: { value: Math.min(devicePixelRatio, 2) } },
      vertexShader: /* glsl */ `
        attribute float aAlpha;
        uniform float uPR;
        varying float vA;
        void main() {
          vA = aAlpha;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = uPR * ${o.size.toFixed(1)} / max(0.5, -mv.z);
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: /* glsl */ `
        varying float vA;
        void main() {
          float d = length(gl_PointCoord - 0.5);
          float a = smoothstep(0.5, 0.16, d) * vA;
          gl_FragColor = vec4(vec3(${o.color}), a);
        }
      `,
    })

    this.points = new THREE.Points(geo, mat)
    // Выброс живёт доли секунды у самого лица: считать для него bounding sphere
    // каждый кадр дороже, чем нарисовать.
    this.points.frustumCulled = false
    scene.add(this.points)
  }

  /** `point` — очаг выброса, `dir` — направление (модуль = сила), `n` — сколько частиц. */
  spawn(point: THREE.Vector3, dir: THREE.Vector3, n = 26) {
    for (let i = 0; i < n; i++) {
      if (this.live.length >= this.max) break
      // равномерная точка на сфере плюс направление выброса
      const a = Math.random() * Math.PI * 2
      const c = Math.random() * 2 - 1
      const s = Math.sqrt(1 - c * c)
      const sp = 0.5 + Math.random() * 0.9
      this.live.push({
        x: point.x + (Math.random() - 0.5) * 0.24,
        y: point.y + Math.random() * 0.12,
        z: point.z + (Math.random() - 0.5) * 0.24,
        vx: dir.x * (0.5 + Math.random() * 0.9) + Math.cos(a) * s * sp,
        vy: dir.y * (0.5 + Math.random() * 0.9) + Math.abs(c) * sp * 0.8,
        vz: dir.z * (0.5 + Math.random() * 0.9) + Math.sin(a) * s * sp,
        age: 0,
        ttl: 0.45 + Math.random() * 0.35,
      })
    }
  }

  update(dt: number) {
    const geo = this.points.geometry
    if (this.live.length === 0) {
      geo.setDrawRange(0, 0)
      return
    }

    const drag = Math.exp(-this.drag * dt)
    for (let i = this.live.length - 1; i >= 0; i--) {
      const p = this.live[i]
      p.age += dt
      if (p.age >= p.ttl) {
        // мёртвую заменяем последней и укорачиваем массив: порядок не важен,
        // а splice на каждой частице каждый кадр — это лишние копии
        this.live[i] = this.live[this.live.length - 1]
        this.live.pop()
        continue
      }
      p.vy -= this.gravity * dt
      p.vx *= drag
      p.vz *= drag
      p.x += p.vx * dt
      p.y += p.vy * dt
      p.z += p.vz * dt
    }

    for (let i = 0; i < this.live.length; i++) {
      const p = this.live[i]
      this.posArr[i * 3] = p.x
      this.posArr[i * 3 + 1] = p.y
      this.posArr[i * 3 + 2] = p.z
      this.aArr[i] = 0.85 * (1 - p.age / p.ttl)
    }
    geo.attributes.position.needsUpdate = true
    geo.attributes.aAlpha.needsUpdate = true
    geo.setDrawRange(0, this.live.length)
  }
}
