// @targets spec, package
// A generated image states both dimensions or neither at the provider boundary, and always
// both once the core has normalized it; the declarations refuse the in-between shapes.
import type { GeneratedImage, ProviderImage, ProviderResponse } from 'llmdispatch'

// @expect TS2322
export const widthOnly: ProviderImage = { mediaType: 'image/png', data: 'AAAA', width: 10 }

// @expect TS2322
export const heightOnly: ProviderImage = { mediaType: 'image/png', data: 'AAAA', height: 10 }

// @expect TS2322
export const notRaster: ProviderImage = { mediaType: 'image/gif', data: 'AAAA' }

// @expect TS2739
export const undimensioned: GeneratedImage = {
  type: 'file',
  mediaType: 'image/png',
  data: 'AAAA',
}

export const onTruncated: ProviderResponse = {
  kind: 'truncated',
  text: '',
  usage: null,
  // @expect TS2353
  images: [],
}
