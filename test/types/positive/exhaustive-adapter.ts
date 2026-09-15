// @targets spec, package
// A custom adapter that switches on every `responseFormat.type`: the union is closed, so
// `assertNever` compiles only while the adapter handles each member, and the image member
// is one of them.
import { ProviderError, type Provider, type ProviderRequest } from 'llmdispatch'

function assertNever(value: never): never {
  throw new Error(`unhandled response format ${String(value)}`)
}

function wireFormat(format: ProviderRequest['responseFormat']): string {
  switch (format.type) {
    case 'text':
      return 'text'
    case 'json':
      return format.topLevel === 'object' ? 'json_object' : 'json'
    case 'image': {
      const count: number = format.count ?? 1
      const ratio: string = format.aspectRatio ?? '1:1'
      const size: string = format.size ?? '1K'
      const background: string = format.background ?? 'opaque'
      return `image:${String(count)}:${ratio}:${size}:${background}`
    }
    default:
      return assertNever(format)
  }
}

export const exhaustive: Provider = {
  complete(req) {
    const wire = wireFormat(req.responseFormat)
    if (wire.startsWith('image:')) {
      return Promise.resolve({
        kind: 'complete',
        text: '',
        images: [{ mediaType: 'image/png', data: 'AAAA' }],
        usage: null,
      })
    }
    return Promise.reject(new ProviderError('invalid_request'))
  },
}
