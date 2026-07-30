/**
 * plan.ts — схема расстановки видом сверху, 2D-канвасом по константам `layout.ts`.
 *
 * Почему не скриншот с высоты: теней в сцене нет, и сверху всё сливается
 * в ровную заливку — проверено в сессии 4. Пятна, дорожка и мачты видны
 * только нарисованные по числам.
 *
 * Инструмент автора, а не игрока: горячей клавиши у схемы нет, поднимается она
 * из консоли — `wt.world.plan.toggle()`. Рисуется один раз при первом показе:
 * мир статичен.
 */

import { SPOTS, PATH, PATH_W, STAIR, LATTICE, THIN_MASTS } from './layout'
import { checkLayout } from './check'
import { stairProfile } from './stairProfile'
import { heightAt } from './terrain'

// Границы схемы в мировых координатах и масштаб.
const X0 = -32
const X1 = 34
const Z0 = -72
const Z1 = 20
const PX = 5.5 // пикселей на метр

export function createPlan(spawn: { x: number; z: number }): { toggle: () => void } {
  const W = Math.round((X1 - X0) * PX)
  const H = Math.round((Z1 - Z0) * PX)
  const cv = document.createElement('canvas')
  cv.width = W
  cv.height = H
  cv.style.cssText =
    'position:fixed;right:8px;top:8px;z-index:5;display:none;' +
    'border:1px solid #395;background:#0d1b23;image-rendering:pixelated'
  document.body.appendChild(cv)

  const g = cv.getContext('2d')!
  const sx = (x: number) => (x - X0) * PX
  const sz = (z: number) => (z - Z0) * PX

  let drawn = false

  function draw() {
    g.fillStyle = '#0d1b23'
    g.fillRect(0, 0, W, H)

    // Подложка: высота рельефа в серых тонах — сразу видно гребень, обрыв и полку.
    for (let px = 0; px < W; px += 3) {
      for (let pz = 0; pz < H; pz += 3) {
        const h = heightAt(X0 + px / PX, Z0 + pz / PX)
        const t = Math.max(0, Math.min(1, (h + 20) / 45))
        g.fillStyle = `rgb(${(28 + t * 90) | 0},${(44 + t * 110) | 0},${(56 + t * 120) | 0})`
        g.fillRect(px, pz, 3, 3)
      }
    }

    // Коридор дорожки: то, внутри чего не должно стоять ничего.
    g.strokeStyle = 'rgba(120,220,255,0.22)'
    g.lineWidth = (PATH_W + 2.4) * PX
    g.lineCap = 'round'
    g.beginPath()
    PATH.forEach(([x, z], i) => (i ? g.lineTo(sx(x), sz(z)) : g.moveTo(sx(x), sz(z))))
    g.stroke()

    // Сама лента дорожки.
    g.strokeStyle = '#7fd6ff'
    g.lineWidth = PATH_W * PX
    g.beginPath()
    PATH.forEach(([x, z], i) => (i ? g.lineTo(sx(x), sz(z)) : g.moveTo(sx(x), sz(z))))
    g.stroke()

    // Лестница: ломаная во всю ширину марша, с отметкой стыка и низа.
    const stair = stairProfile()
    g.strokeStyle = '#ffd27f'
    g.lineWidth = STAIR.width * PX
    g.lineCap = 'butt'
    g.beginPath()
    STAIR.line.forEach(([x, z], i) => (i ? g.lineTo(sx(x), sz(z)) : g.moveTo(sx(x), sz(z))))
    g.stroke()
    // Поворотная площадка — то место, где лестница три сессии не стыковалась
    // с дорожкой. Круг радиусом с пандус, которым лента на неё выходит.
    g.strokeStyle = '#ff9d3f'
    g.lineWidth = 2
    g.beginPath()
    g.arc(sx(stair.join.x), sz(stair.join.z), stair.join.rampLen * PX, 0, Math.PI * 2)
    g.stroke()
    g.lineCap = 'round'

    // Пятна застройки.
    g.lineWidth = 1.5
    g.font = '10px monospace'
    g.textBaseline = 'top'
    for (const s of SPOTS) {
      const x = sx(s.x0)
      const z = sz(s.z0)
      const w = (s.x1 - s.x0) * PX
      const d = (s.z1 - s.z0) * PX
      g.fillStyle = s.h ? 'rgba(230,240,245,0.30)' : 'rgba(160,200,220,0.18)'
      g.fillRect(x, z, w, d)
      g.strokeStyle = '#e6f0f5'
      g.strokeRect(x, z, w, d)
      g.fillStyle = '#e6f0f5'
      g.fillText(s.name, x + 3, z + 3)
    }

    // Мачты.
    const dot = (x: number, z: number, r: number, color: string) => {
      g.fillStyle = color
      g.beginPath()
      g.arc(sx(x), sz(z), r, 0, Math.PI * 2)
      g.fill()
    }
    dot(LATTICE.x, LATTICE.z, 5, '#ff6b4a')
    for (const [x, z] of THIN_MASTS) dot(x, z, 3, '#b9d6e2')

    // Игрок и направление взгляда (yaw 0 = в -Z).
    dot(spawn.x, spawn.z, 4, '#6cff9b')
    g.strokeStyle = '#6cff9b'
    g.lineWidth = 2
    g.beginPath()
    g.moveTo(sx(spawn.x), sz(spawn.z))
    g.lineTo(sx(spawn.x - Math.sin(0.14) * 12), sz(spawn.z - Math.cos(0.14) * 12))
    g.stroke()

    // Претензии проверки — прямо на схеме, чтобы не лезть в консоль.
    const bad = checkLayout()
    g.font = '11px monospace'
    g.fillStyle = bad.length ? '#ff8a6b' : '#6cff9b'
    g.fillText(bad.length ? `проверка: ${bad.length} претензий` : 'проверка зелёная', 6, H - 18)
  }

  return {
    toggle() {
      if (!drawn) {
        draw()
        drawn = true
      }
      cv.style.display = cv.style.display === 'none' ? 'block' : 'none'
    },
  }
}
