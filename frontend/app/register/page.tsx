'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useAuth } from '@/contexts/AuthContext'
import Link from 'next/link'

function getErrorMessage(error: unknown, fallback: string) {
  if (error instanceof Error) return error.message
  if (typeof error === 'object' && error !== null && 'message' in error) {
    const message = (error as { message?: unknown }).message
    if (typeof message === 'string') return message
  }
  return fallback
}

export default function RegisterPage() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [fullName, setFullName] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const router = useRouter()
  const { signUp } = useAuth()

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    setLoading(true)

    if (!email || !password || !fullName) {
      setError('모든 필드를 입력해주세요.')
      setLoading(false)
      return
    }

    if (password.length < 6) {
      setError('비밀번호는 최소 6자 이상이어야 합니다.')
      setLoading(false)
      return
    }

    const { error } = await signUp(email, password, fullName)

    if (error) {
      setError(getErrorMessage(error, '회원가입에 실패했습니다.'))
      setLoading(false)
    } else {
      router.push('/dashboard')
    }
  }

  return (
    <main className="relative min-h-screen overflow-hidden bg-[#eaf0f7] px-5 py-8 text-slate-950">
      <div className="pointer-events-none absolute -left-24 bottom-8 h-80 w-80 rounded-full bg-cyan-200/45 blur-3xl" />
      <div className="pointer-events-none absolute -right-20 top-10 h-96 w-96 rounded-full bg-emerald-100/70 blur-3xl" />
      <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(135deg,rgba(255,255,255,0.74),transparent_46%)]" />

      <div className="relative mx-auto grid min-h-[calc(100vh-4rem)] w-full max-w-6xl items-center gap-8 lg:grid-cols-[0.95fr_1.05fr]">
        <section className="order-2 rounded-[34px] border border-white/70 bg-white/90 p-7 shadow-[0_24px_70px_rgba(15,23,42,0.14)] backdrop-blur-xl sm:p-9 lg:order-1">
          <div className="mb-8">
            <p className="text-xs font-semibold uppercase tracking-[0.22em] text-cyan-700">Create account</p>
            <h1 className="mt-2 text-3xl font-black tracking-[-0.03em] text-slate-950">워크스페이스 시작하기</h1>
            <p className="mt-2 text-sm text-slate-500">이름과 이메일만으로 회의 AI 공간을 만들 수 있습니다.</p>
          </div>

          <form onSubmit={handleSubmit} className="space-y-5">
            <div>
              <label htmlFor="fullName" className="mb-2 block text-sm font-semibold text-slate-700">
                이름
              </label>
              <input
                id="fullName"
                type="text"
                value={fullName}
                onChange={(e) => setFullName(e.target.value)}
                className="w-full rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-slate-900 outline-none transition focus:border-cyan-500 focus:bg-white focus:ring-4 focus:ring-cyan-100"
                placeholder="홍길동"
                required
              />
            </div>

            <div>
              <label htmlFor="email" className="mb-2 block text-sm font-semibold text-slate-700">
                이메일
              </label>
              <input
                id="email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="w-full rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-slate-900 outline-none transition focus:border-cyan-500 focus:bg-white focus:ring-4 focus:ring-cyan-100"
                placeholder="example@email.com"
                required
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
                className="w-full rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-slate-900 outline-none transition focus:border-cyan-500 focus:bg-white focus:ring-4 focus:ring-cyan-100"
                placeholder="최소 6자 이상"
                required
              />
            </div>

            {error && (
              <div className="rounded-2xl border border-red-200 bg-red-50 p-4 text-sm font-medium text-red-700">
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={loading}
              className="w-full rounded-2xl bg-[#10243f] px-4 py-3.5 font-bold text-white shadow-[0_16px_34px_rgba(15,23,42,0.2)] transition hover:bg-[#163154] disabled:cursor-not-allowed disabled:opacity-55"
            >
              {loading ? '가입 중...' : '회원가입'}
            </button>
          </form>

          <p className="mt-6 text-center text-sm text-slate-500">
            이미 계정이 있으신가요?{' '}
            <Link href="/login" className="font-bold text-cyan-700 hover:text-cyan-800">
              로그인
            </Link>
          </p>
        </section>

        <section className="order-1 rounded-[34px] border border-white/65 bg-[#10243f] p-8 text-white shadow-[0_34px_90px_rgba(15,23,42,0.24)] sm:p-10 lg:order-2">
          <div className="inline-flex rounded-full border border-white/15 bg-white/10 px-3 py-1 text-xs font-semibold uppercase tracking-[0.22em] text-cyan-100">
            IMMS Workspace
          </div>
          <h2 className="mt-8 text-4xl font-black tracking-[-0.04em] sm:text-5xl">
            회의 전 과정을 하나의 세션으로 유지합니다
          </h2>
          <p className="mt-5 max-w-xl text-base leading-7 text-slate-200">
            STT, 안건 분류, 문제 정의, 해결책 캔버스가 같은 회의 상태를 공유하도록 설계된 협업형 AI 보드입니다.
          </p>
          <div className="mt-8 space-y-3">
            {["실시간 공유 상태", "개인 메모 보존", "AI 안건/인사이트 생성"].map((item) => (
              <div key={item} className="flex items-center gap-3 rounded-2xl border border-white/12 bg-white/9 px-4 py-3 text-sm font-semibold text-cyan-50">
                <span className="h-2.5 w-2.5 rounded-full bg-cyan-300" />
                {item}
              </div>
            ))}
          </div>
        </section>
      </div>
    </main>
  )
}
