// @targets spec, package
// A generated SVG carries exactly one media type, a vector has no size knob, and a document
// is not a file part: the declarations refuse the shapes that would blur any of that.
import type {
  ContentPart,
  GeneratedSvg,
  ProviderResponse,
  ProviderSvg,
  SvgOptions,
} from 'llmdispatch'

// @expect TS2322
export const raster: ProviderSvg = { mediaType: 'image/png', data: 'AAAA' }

export const wrongType: GeneratedSvg = {
  // @expect TS2322
  type: 'file',
  mediaType: 'image/svg+xml',
  data: 'AAAA',
}

// @expect TS2353
export const sized: SvgOptions = { size: '1K' }

export function asPart(svg: GeneratedSvg): ContentPart {
  // @expect TS2322
  return svg
}

export const onTruncated: ProviderResponse = {
  kind: 'truncated',
  text: '',
  usage: null,
  // @expect TS2353
  svgs: [],
}
