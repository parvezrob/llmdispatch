// @targets spec, package
// The media types are a closed set, and every part field is readonly, so a file the package
// cannot carry and a part an adapter tries to rewrite are both compile errors.
import type { ContentPart, FilePart, ProviderRequest } from 'llmdispatch'

export const unsupportedMediaType: FilePart = {
  type: 'file',
  // @expect TS2322
  mediaType: 'image/heic',
  data: 'QUJDRA==',
}

export function rewritePart(part: FilePart): void {
  // @expect TS2540
  part.data = 'QUJDRQ=='
}

export function retypePart(part: ContentPart): void {
  // @expect TS2540
  part.type = 'text'
}

export function replaceParts(req: ProviderRequest): void {
  // @expect TS2339
  req.parts.push({ type: 'text', text: 'appended' })
}
