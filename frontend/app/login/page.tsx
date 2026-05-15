"use client"

import { useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useAuth } from '@/contexts/AuthContext'

function getErrorMessage(error: unknown, fallback: string) {
  if (error instanceof Error) return error.message
  if (typeof error === 'object' && error !== null && 'message' in error) {
    const message = (error as { message?: unknown }).message
    if (typeof message === 'string') return message
  }
  return fallback
}

export default function LoginPage() {
  const router = useRouter()
  const { signIn, loading: authLoading } = useAuth()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    setLoading(true)

    try {
      await signIn(email, password)
      router.push('/dashboard')
    } catch (err) {
      setError(getErrorMessage(err, '로그인에 실패했습니다.'))
    } finally {
      setLoading(false)
    }
  }

  if (authLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#eaf0f7]">
        <div className="rounded-[28px] border border-white/70 bg-white/85 px-8 py-7 text-center shadow-[0_24px_70px_rgba(15,23,42,0.12)] backdrop-blur-xl">
          <div className="mx-auto h-12 w-12 animate-spin rounded-full border-[3px] border-cyan-100 border-t-[#10243f]" />
          <p className="mt-4 text-sm font-medium text-slate-600">로딩 중...</p>
        </div>
      </div>
    )
  }

  return (
    <main className="relative min-h-screen overflow-hidden bg-[#eaf0f7] px-5 py-8 text-slate-950">
      <div className="pointer-events-none absolute -left-24 top-10 h-72 w-72 rounded-full bg-cyan-200/45 blur-3xl" />
      <div className="pointer-events-none absolute -right-28 bottom-6 h-96 w-96 rounded-full bg-slate-300/55 blur-3xl" />
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_50%_0%,rgba(255,255,255,0.78),transparent_42%)]" />

      <div className="relative mx-auto grid min-h-[calc(100vh-4rem)] w-full max-w-6xl items-center gap-8 lg:grid-cols-[1.05fr_0.95fr]">
        <section className="rounded-[34px] border border-white/65 bg-[#10243f] p-8 text-white shadow-[0_34px_90px_rgba(15,23,42,0.24)] sm:p-10">
          <div className="inline-flex rounded-full border border-white/15 bg-white/10 px-3 py-1 text-xs font-semibold uppercase tracking-[0.22em] text-cyan-100">
            Meeting AI Assistant
          </div>
          <h1 className="mt-8 text-4xl font-black tracking-[-0.04em] sm:text-5xl">
            회의 흐름을 놓치지 않는 AI 워크스페이스
          </h1>
          <p className="mt-5 max-w-xl text-base leading-7 text-slate-200">
            실시간 전사, 안건 분석, 캔버스 정리, 개인 메모를 하나의 회의 단위로 연결합니다.
          </p>
          <div className="mt-8 grid gap-3 sm:grid-cols-3">
            {["Live STT", "Agenda Canvas", "Team Sync"].map((item) => (
              <div key={item} className="rounded-2xl border border-white/12 bg-white/9 px-4 py-3 text-sm font-semibold text-cyan-50">
                {item}
              </div>
            ))}
          </div>
        </section>

        <section className="rounded-[34px] border border-white/70 bg-white/90 p-7 shadow-[0_24px_70px_rgba(15,23,42,0.14)] backdrop-blur-xl sm:p-9">
          <div className="mb-8">
            <p className="text-xs font-semibold uppercase tracking-[0.22em] text-cyan-700">Sign in</p>
            <h2 className="mt-2 text-3xl font-black tracking-[-0.03em] text-slate-950">IMMS 로그인</h2>
            <p className="mt-2 text-sm text-slate-500">회의 대시보드와 공유 캔버스에 접속합니다.</p>
          </div>

          <form onSubmit={handleSubmit} className="space-y-5">
            <div>
              <label htmlFor="email" className="mb-2 block text-sm font-semibold text-slate-700">
                이메일
              </label>
              <input
                id="email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                className="w-full rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-slate-900 outline-none transition focus:border-cyan-500 focus:bg-white focus:ring-4 focus:ring-cyan-100"
                placeholder="your@email.com"
              />
            </div>

            <div>
              <label htmlFor="password" className="mb-2 block text-sm font-semibold text-slate-700">
                비밀번호
              </label>
              <input
                id="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                className="w-full rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-slate-900 outline-none transition focus:border-cyan-500 focus:bg-white focus:ring-4 focus:ring-cyan-100"
                placeholder="••••••••"
              />
            </div>

            {error && (
              <div className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm font-medium text-red-700">
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={loading}
              className="w-full rounded-2xl bg-[#10243f] px-4 py-3.5 font-bold text-white shadow-[0_16px_34px_rgba(15,23,42,0.2)] transition hover:bg-[#163154] disabled:cursor-not-allowed disabled:opacity-55"
            >
              {loading ? '로그인 중...' : '로그인'}
            </button>
          </form>

          <p className="mt-6 text-center text-sm text-slate-500">
            계정이 없으신가요?{' '}
            <Link href="/register" className="font-bold text-cyan-700 hover:text-cyan-800">
              회원가입
            </Link>
          </p>
        </section>
      </div>
    </main>
  )
}
