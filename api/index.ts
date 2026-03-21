import app from '../server/index.js'

type QueryValue = string | string[] | undefined

type VercelLikeRequest = {
  url?: string
  query?: Record<string, QueryValue>
}

function toFirst(value: QueryValue): string {
  if (Array.isArray(value)) {
    return value[0] ?? ''
  }
  return value ?? ''
}

function removeInternalKeys(query: Record<string, QueryValue>): URLSearchParams {
  const params = new URLSearchParams()

  for (const [key, rawValue] of Object.entries(query)) {
    if (key === 'path') {
      continue
    }

    if (Array.isArray(rawValue)) {
      for (const value of rawValue) {
        params.append(key, value)
      }
      continue
    }

    if (typeof rawValue === 'string') {
      params.append(key, rawValue)
    }
  }

  return params
}

export default function handler(req: VercelLikeRequest, res: unknown): unknown {
  const query = req.query ?? {}
  const rawPath = toFirst(query.path).replace(/^\/+/, '')

  if (rawPath) {
    const params = removeInternalKeys(query)
    const search = params.toString()
    req.url = `/api/${rawPath}${search ? `?${search}` : ''}`
  }

  return (app as unknown as (request: unknown, response: unknown) => unknown)(req, res)
}
