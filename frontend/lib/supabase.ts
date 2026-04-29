import { createClient } from '@supabase/supabase-js'

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || ''
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || ''

if (!supabaseUrl || !supabaseAnonKey) {
  console.warn('⚠️ Supabase URL or Anon Key is missing. Please set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY in .env.local')
}

function getSafeUrl(value: string) {
  try {
    const url = new URL(value)
    return `${url.origin}${url.pathname}${url.search ? '?...' : ''}`
  } catch {
    return value
  }
}

function getRequestUrl(input: RequestInfo | URL) {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.toString()
  return input.url
}

function getRequestMethod(input: RequestInfo | URL, init?: RequestInit) {
  if (init?.method) return init.method
  if (typeof input === 'string' || input instanceof URL) return 'GET'
  return input.method || 'GET'
}

function getSupabaseHost() {
  try {
    return supabaseUrl ? new URL(supabaseUrl).host : ''
  } catch {
    return ''
  }
}

function inferSupabaseFailureReason(error: unknown) {
  const typedError = error as { message?: string; name?: string; status?: number; code?: string }

  if (!supabaseUrl || !supabaseAnonKey) {
    return 'Supabase 환경변수(NEXT_PUBLIC_SUPABASE_URL 또는 NEXT_PUBLIC_SUPABASE_ANON_KEY)가 비어 있습니다.'
  }

  try {
    new URL(supabaseUrl)
  } catch {
    return 'NEXT_PUBLIC_SUPABASE_URL 형식이 올바른 URL이 아닙니다.'
  }

  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    return '브라우저가 오프라인 상태라 Supabase에 연결할 수 없습니다.'
  }

  if (typeof typedError.status === 'number') {
    if (typedError.status === 401) return 'Supabase 인증 토큰이 만료되었거나 잘못되었습니다. 다시 로그인해야 합니다.'
    if (typedError.status === 403) return 'Supabase 권한 또는 RLS 정책 때문에 요청이 거부되었습니다.'
    if (typedError.status === 429) return 'Supabase 요청 제한에 걸렸습니다. 잠시 후 다시 시도해야 합니다.'
    if (typedError.status >= 500) return 'Supabase 서버 또는 프로젝트 상태 문제로 요청이 실패했습니다.'
    return `Supabase가 HTTP ${typedError.status} 응답을 반환했습니다.`
  }

  if (typedError.message?.toLowerCase().includes('failed to fetch')) {
    return '브라우저가 Supabase 응답을 받기 전에 요청이 실패했습니다. 네트워크, CORS, DNS, VPN/방화벽, 광고 차단, Supabase 프로젝트 일시정지를 확인해야 합니다.'
  }

  return typedError.message || '알 수 없는 Supabase 요청 실패입니다.'
}

export function getSupabaseFailureDiagnostics(error: unknown) {
  const typedError = error as { message?: string; name?: string; status?: number; code?: string; cause?: unknown }

  return {
    reason: inferSupabaseFailureReason(error),
    errorName: typedError.name || '',
    errorMessage: typedError.message || String(error),
    status: typedError.status || null,
    code: typedError.code || null,
    cause: typedError.cause ? String(typedError.cause) : '',
    supabaseUrlConfigured: Boolean(supabaseUrl),
    supabaseAnonKeyConfigured: Boolean(supabaseAnonKey),
    supabaseHost: getSupabaseHost(),
    currentOrigin: typeof window !== 'undefined' ? window.location.origin : '',
    online: typeof navigator !== 'undefined' ? navigator.onLine : null,
  }
}

export function logSupabaseFailure(context: string, error: unknown, extra?: Record<string, unknown>) {
  const diagnostics = {
    ...getSupabaseFailureDiagnostics(error),
    ...(extra || {}),
  }

  console.warn(
    `[Supabase] ${context} failed: ${diagnostics.reason}`,
    diagnostics,
  )
}

const diagnosticFetch: typeof fetch = async (input, init) => {
  const url = getRequestUrl(input)
  const method = getRequestMethod(input, init)
  const startedAt = Date.now()

  try {
    const response = await fetch(input, init)
    if (!response.ok && url.includes('/auth/v1/')) {
      logSupabaseFailure('auth request', { status: response.status, message: response.statusText }, {
        requestUrl: getSafeUrl(url),
        method,
        elapsedMs: Date.now() - startedAt,
      })
    }
    return response
  } catch (error) {
    logSupabaseFailure('network request', error, {
      requestUrl: getSafeUrl(url),
      method,
      elapsedMs: Date.now() - startedAt,
    })
    throw error
  }
}

export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  global: {
    fetch: diagnosticFetch,
  },
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true
  }
})
