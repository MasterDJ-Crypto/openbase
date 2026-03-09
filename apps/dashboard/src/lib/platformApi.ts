'use client'

import { z } from 'zod'

const PLATFORM_ACCESS_TOKEN_KEY = 'openbase_platform_token'
const PLATFORM_REFRESH_TOKEN_KEY = 'openbase_platform_refresh'
const PROJECT_SESSION_PREFIX = 'openbase_project_session:'

export interface PlatformSession {
    accessToken: string
    refreshToken: string | null
}

export function getApiUrl(): string {
    return process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001'
}

export function getPlatformSession(): PlatformSession | null {
    if (typeof window === 'undefined') {
        return null
    }

    const accessToken = window.localStorage.getItem(PLATFORM_ACCESS_TOKEN_KEY)
    const refreshToken = window.localStorage.getItem(PLATFORM_REFRESH_TOKEN_KEY)

    if (!accessToken) {
        return null
    }

    return {
        accessToken,
        refreshToken,
    }
}

export function hasPlatformSession(): boolean {
    return getPlatformSession() !== null
}

export function setPlatformSession(session: { access_token?: string; refresh_token?: string }): void {
    if (typeof window === 'undefined' || !session.access_token) {
        return
    }

    window.localStorage.setItem(PLATFORM_ACCESS_TOKEN_KEY, session.access_token)

    if (session.refresh_token) {
        window.localStorage.setItem(PLATFORM_REFRESH_TOKEN_KEY, session.refresh_token)
    } else {
        window.localStorage.removeItem(PLATFORM_REFRESH_TOKEN_KEY)
    }
}

export function clearPlatformSession(): void {
    if (typeof window === 'undefined') {
        return
    }

    window.localStorage.removeItem(PLATFORM_ACCESS_TOKEN_KEY)
    window.localStorage.removeItem(PLATFORM_REFRESH_TOKEN_KEY)
}

export function setProjectAuthSession(
    projectId: string,
    session: { access_token: string; refresh_token?: string }
): void {
    if (typeof window === 'undefined') {
        return
    }

    window.localStorage.setItem(
        `${PROJECT_SESSION_PREFIX}${projectId}`,
        JSON.stringify({
            access_token: session.access_token,
            refresh_token: session.refresh_token ?? null,
            stored_at: new Date().toISOString(),
        })
    )
}

export function getProjectAuthSession(projectId: string): { access_token: string; refresh_token?: string } | null {
    if (typeof window === 'undefined') {
        return null
    }

    const raw = window.localStorage.getItem(`${PROJECT_SESSION_PREFIX}${projectId}`)
    if (!raw) {
        return null
    }

    try {
        return JSON.parse(raw) as { access_token: string; refresh_token?: string }
    } catch {
        return null
    }
}

export function clearProjectAuthSession(projectId: string): void {
    if (typeof window === 'undefined') {
        return
    }

    window.localStorage.removeItem(`${PROJECT_SESSION_PREFIX}${projectId}`)
}

export async function refreshProjectAuthSession(projectId: string): Promise<string | null> {
    const session = getProjectAuthSession(projectId)
    if (!session?.refresh_token) {
        clearProjectAuthSession(projectId)
        return null
    }

    const response = await fetch(`${getApiUrl()}/api/v1/${projectId}/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh_token: session.refresh_token }),
    })

    if (!response.ok) {
        clearProjectAuthSession(projectId)
        return null
    }

    const payload = await response.json() as { data?: { session?: { access_token?: string; refresh_token?: string } } }
    const nextSession = payload.data?.session
    if (!nextSession?.access_token) {
        clearProjectAuthSession(projectId)
        return null
    }

    const normalizedSession = {
        access_token: nextSession.access_token,
        ...(nextSession.refresh_token ? { refresh_token: nextSession.refresh_token } : {}),
    }

    setProjectAuthSession(projectId, normalizedSession)
    return normalizedSession.access_token
}

export async function authenticatedProjectFetch(
    projectId: string,
    input: string,
    init: RequestInit = {}
): Promise<Response> {
    const session = getProjectAuthSession(projectId)
    if (!session?.access_token) {
        throw new Error('Project auth session missing')
    }

    const execute = async (accessToken: string) => fetch(input, {
        ...init,
        headers: {
            ...(init.headers || {}),
            Authorization: `Bearer ${accessToken}`,
            apikey: accessToken,
        },
    })

    let response = await execute(session.access_token)
    if (response.status !== 401) {
        return response
    }

    const refreshedToken = await refreshProjectAuthSession(projectId)
    if (!refreshedToken) {
        return response
    }

    response = await execute(refreshedToken)
    return response
}

export async function refreshPlatformSession(): Promise<string | null> {
    const session = getPlatformSession()
    if (!session?.refreshToken) {
        clearPlatformSession()
        return null
    }

    const response = await fetch(`${getApiUrl()}/api/v1/platform/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh_token: session.refreshToken }),
    })

    if (!response.ok) {
        clearPlatformSession()
        return null
    }

    const payload = await response.json() as { data?: { session?: { access_token?: string; refresh_token?: string } } }
    const nextSession = payload.data?.session
    if (!nextSession?.access_token) {
        clearPlatformSession()
        return null
    }

    setPlatformSession(nextSession)
    return nextSession.access_token
}

export async function signOutPlatform(): Promise<void> {
    const session = getPlatformSession()

    try {
        if (session?.refreshToken) {
            await fetch(`${getApiUrl()}/api/v1/platform/auth/signout`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ refresh_token: session.refreshToken }),
            })
        }
    } finally {
        clearPlatformSession()
    }
}

export async function authenticatedFetch(input: string, init: RequestInit = {}): Promise<Response> {
    const session = getPlatformSession()
    if (!session?.accessToken) {
        throw new Error('Platform session missing')
    }

    const execute = async (accessToken: string) => fetch(input, {
        ...init,
        headers: {
            ...(init.headers || {}),
            Authorization: `Bearer ${accessToken}`,
        },
    })

    let response = await execute(session.accessToken)
    if (response.status !== 401) {
        return response
    }

    const refreshedToken = await refreshPlatformSession()
    if (!refreshedToken) {
        return response
    }

    response = await execute(refreshedToken)
    return response
}

export async function readApiEnvelope<TSchema extends z.ZodTypeAny>(
    response: Response,
    schema: TSchema
): Promise<z.infer<TSchema>> {
    const payload = await response.json() as {
        data?: unknown
        error?: { message?: string } | null
    }

    if (!response.ok || payload.error) {
        throw new Error(payload.error?.message || `HTTP ${response.status}`)
    }

    return schema.parse(payload.data)
}
