'use client'

import React, { createContext, useContext, useState, useEffect } from 'react'
import { logSupabaseFailure, supabase } from '@/lib/supabase'
import { User, Session } from '@supabase/supabase-js'

interface AuthContextType {
  user: User | null
  session: Session | null
  loading: boolean
  signUp: (email: string, password: string, fullName: string) => Promise<{ error: unknown }>
  signIn: (email: string, password: string) => Promise<{ error: unknown }>
  signOut: () => Promise<void>
}

const AuthContext = createContext<AuthContextType | undefined>(undefined)

function resolveProfileName(user: User, fullName?: string) {
  const metadataName = typeof user.user_metadata?.full_name === 'string' ? user.user_metadata.full_name.trim() : ''
  const providedName = fullName?.trim() || metadataName
  if (providedName) return providedName
  if (user.email) return user.email.split('@')[0]
  return '사용자'
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null)
  const [session, setSession] = useState<Session | null>(null)
  const [loading, setLoading] = useState(true)

  const ensureUserProfile = async (authUser: User, fullName?: string) => {
    let error: unknown = null

    try {
      const result = await supabase
        .from('user_profiles')
        .upsert(
          {
            id: authUser.id,
            name: resolveProfileName(authUser, fullName),
          },
          {
            onConflict: 'id',
            ignoreDuplicates: true,
          }
        )
      error = result.error
    } catch (caughtError) {
      error = caughtError
    }

    if (error) {
      logSupabaseFailure('profile upsert', error)
    }

    return error
  }

  useEffect(() => {
    let cancelled = false

    const applySession = (session: Session | null) => {
      if (cancelled) return
      setSession(session)
      setUser(session?.user ?? null)
      if (session?.user) {
        void ensureUserProfile(session.user)
      }
      setLoading(false)
    }

    const handleSessionError = (error: unknown) => {
      if (cancelled) return
      logSupabaseFailure('auth session recovery', error)
      setSession(null)
      setUser(null)
      setLoading(false)
    }

    // Check active session
    supabase.auth
      .getSession()
      .then(({ data: { session } }) => applySession(session))
      .catch(handleSessionError)

    // Listen for auth changes
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      applySession(session)
    })

    return () => {
      cancelled = true
      subscription.unsubscribe()
    }
  }, [])

  const signUp = async (email: string, password: string, fullName: string) => {
    try {
      const { data, error } = await supabase.auth.signUp({
        email,
        password,
        options: {
          data: {
            full_name: fullName
          }
        }
      })

      if (error) {
        logSupabaseFailure('sign up', error)
      }

      if (!error && data.user && data.session) {
        await ensureUserProfile(data.user, fullName)
      }

      return { error }
    } catch (error) {
      logSupabaseFailure('sign up', error)
      return { error }
    }
  }

  const signIn = async (email: string, password: string) => {
    try {
      const { data, error } = await supabase.auth.signInWithPassword({
        email,
        password
      })

      if (error) {
        logSupabaseFailure('sign in', error)
      }

      if (!error && data.user) {
        await ensureUserProfile(data.user)
      }

      return { error }
    } catch (error) {
      logSupabaseFailure('sign in', error)
      return { error }
    }
  }

  const signOut = async () => {
    try {
      await supabase.auth.signOut()
    } catch (error) {
      logSupabaseFailure('sign out', error)
    }
  }

  return (
    <AuthContext.Provider value={{ user, session, loading, signUp, signIn, signOut }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  const context = useContext(AuthContext)
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider')
  }
  return context
}
