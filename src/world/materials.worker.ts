import { bake, recipe } from 'world-core/materials'

self.onmessage = ({ data: name }: MessageEvent<string>) => {
  try {
    const source = recipe(name)
    const baked = bake(source.gen, source.size, source.normalStrength)
    const transfers = [baked.albedo.buffer, baked.normal.buffer, baked.rough.buffer]
    if (baked.metal) transfers.push(baked.metal.buffer)
    self.postMessage({ name, baked }, { transfer: transfers })
  } catch (error) {
    self.postMessage({ name, error: String(error) })
  }
}
