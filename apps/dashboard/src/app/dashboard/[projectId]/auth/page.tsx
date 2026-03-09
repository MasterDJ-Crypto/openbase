'use client'

import { authResultSchema, authUserSchema } from '@openbase/core'
import { useEffect, useMemo, useState } from 'react'
import { useParams } from 'next/navigation'
import { z } from 'zod'
import {
    Ban,
    CheckCircle2,
    KeyRound,
    Mail,
    Plus,
    RotateCcw,
    ShieldCheck,
    ShieldOff,
    Trash2,
    Users,
} from 'lucide-react'
import {
    authenticatedFetch,
    authenticatedProjectFetch,
    clearProjectAuthSession,
    getApiUrl,
    getProjectAuthSession,
    readApiEnvelope,
    setProjectAuthSession,
} from '../../../../lib/platformApi'

const authProviderSchema = z.object({
    name: z.string(),
    key: z.enum(['email', 'magic_link', 'google', 'github', 'totp']),
    enabled: z.boolean(),
})

type AuthUser = z.infer<typeof authUserSchema>
type AuthProvider = z.infer<typeof authProviderSchema>

const projectMfaEnrollmentSchema = z.object({
    enrollment_token: z.string(),
    secret: z.string(),
    uri: z.string(),
})

const projectMfaVerifySchema = z.object({
    enabled: z.boolean(),
})

const projectSignInSchema = z.union([
    authResultSchema,
    z.object({
        mfa_required: z.literal(true),
        challenge_token: z.string(),
        user: authUserSchema,
    }),
])

export default function AuthSettingsPage() {
    const params = useParams()
    const projectId = params.projectId as string
    const [users, setUsers] = useState<AuthUser[]>([])
    const [providers, setProviders] = useState<AuthProvider[]>([])
    const [loading, setLoading] = useState(true)
    const [providerLoading, setProviderLoading] = useState(true)
    const [inviteEmail, setInviteEmail] = useState('')
    const [invitePassword, setInvitePassword] = useState('')
    const [showInvite, setShowInvite] = useState(false)
    const [error, setError] = useState('')
    const [oauthLoading, setOauthLoading] = useState<string | null>(null)
    const [actionUserId, setActionUserId] = useState<string | null>(null)
    const [projectUser, setProjectUser] = useState<AuthUser | null>(null)
    const [projectAuthEmail, setProjectAuthEmail] = useState('')
    const [projectAuthPassword, setProjectAuthPassword] = useState('')
    const [projectAuthMfaCode, setProjectAuthMfaCode] = useState('')
    const [projectAuthLoading, setProjectAuthLoading] = useState(false)
    const [projectAuthError, setProjectAuthError] = useState('')
    const [projectMfaEnrollment, setProjectMfaEnrollment] = useState<z.infer<typeof projectMfaEnrollmentSchema> | null>(null)
    const [projectMfaVerifyCode, setProjectMfaVerifyCode] = useState('')
    const [projectMfaLoading, setProjectMfaLoading] = useState(false)

    useEffect(() => {
        void fetchUsers()
        void fetchProviders()
        void fetchProjectUser()
    }, [projectId])

    const summary = useMemo(() => ({
        total: users.length,
        disabled: users.filter(user => Boolean(user.disabled_at)).length,
        mfa: users.filter(user => user.totp_enabled).length,
        unconfirmed: users.filter(user => !user.confirmed_at).length,
    }), [users])

    const fetchUsers = async () => {
        try {
            const res = await authenticatedFetch(`${getApiUrl()}/api/v1/${projectId}/auth/users`)
            const data = await readApiEnvelope(res, z.array(authUserSchema))
            setUsers(data)
        } catch {
            setUsers([])
        } finally {
            setLoading(false)
        }
    }

    const fetchProviders = async () => {
        try {
            const res = await authenticatedFetch(`${getApiUrl()}/api/v1/${projectId}/auth/providers`)
            const data = await readApiEnvelope(res, z.array(authProviderSchema))
            setProviders(data)
        } catch {
            setProviders([])
        } finally {
            setProviderLoading(false)
        }
    }

    const fetchProjectUser = async () => {
        if (!getProjectAuthSession(projectId)) {
            setProjectUser(null)
            return
        }

        try {
            const response = await authenticatedProjectFetch(projectId, `${getApiUrl()}/api/v1/${projectId}/auth/user`)
            const data = await readApiEnvelope(response, authUserSchema)
            setProjectUser(data)
        } catch {
            clearProjectAuthSession(projectId)
            setProjectUser(null)
        }
    }

    const runUserAction = async (userId: string, request: RequestInit & { path: string }) => {
        setActionUserId(userId)
        setError('')

        try {
            const response = await authenticatedFetch(`${getApiUrl()}/api/v1/${projectId}${request.path}`, request)
            if (!response.ok) {
                const payload = await response.json()
                throw new Error(payload.error?.message || 'Action failed')
            }
            await fetchUsers()
        } catch (nextError) {
            setError((nextError as Error).message)
        } finally {
            setActionUserId(null)
        }
    }

    const handleProjectSignIn = async () => {
        if (!projectAuthEmail || !projectAuthPassword) {
            setProjectAuthError('Email and password are required.')
            return
        }

        setProjectAuthLoading(true)
        setProjectAuthError('')

        try {
            const response = await fetch(`${getApiUrl()}/api/v1/${projectId}/auth/signin`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    email: projectAuthEmail,
                    password: projectAuthPassword,
                    ...(projectAuthMfaCode ? { mfa_code: projectAuthMfaCode } : {}),
                }),
            })
            const payload = await readApiEnvelope(response, projectSignInSchema)

            if ('mfa_required' in payload) {
                setProjectAuthError('This account requires an MFA code. Enter the current TOTP code and try again.')
                return
            }

            setProjectAuthSession(projectId, payload.session)
            setProjectUser(payload.user)
            setProjectAuthPassword('')
            setProjectAuthMfaCode('')
        } catch (nextError) {
            setProjectAuthError((nextError as Error).message)
        } finally {
            setProjectAuthLoading(false)
        }
    }

    const handleProjectSignOut = async () => {
        const session = getProjectAuthSession(projectId)

        try {
            if (session?.refresh_token) {
                await fetch(`${getApiUrl()}/api/v1/${projectId}/auth/signout`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ refresh_token: session.refresh_token }),
                })
            }
        } finally {
            clearProjectAuthSession(projectId)
            setProjectUser(null)
            setProjectMfaEnrollment(null)
            setProjectMfaVerifyCode('')
        }
    }

    const handleStartMfaEnrollment = async () => {
        setProjectMfaLoading(true)
        setProjectAuthError('')

        try {
            const response = await authenticatedProjectFetch(projectId, `${getApiUrl()}/api/v1/${projectId}/auth/mfa/totp/enroll`, {
                method: 'POST',
            })
            const data = await readApiEnvelope(response, projectMfaEnrollmentSchema)
            setProjectMfaEnrollment(data)
        } catch (nextError) {
            setProjectAuthError((nextError as Error).message)
        } finally {
            setProjectMfaLoading(false)
        }
    }

    const handleVerifyMfaEnrollment = async () => {
        if (!projectMfaEnrollment || !projectMfaVerifyCode) {
            setProjectAuthError('Enter the current authenticator code to complete enrollment.')
            return
        }

        setProjectMfaLoading(true)
        setProjectAuthError('')

        try {
            const response = await authenticatedProjectFetch(projectId, `${getApiUrl()}/api/v1/${projectId}/auth/mfa/totp/verify`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    enrollment_token: projectMfaEnrollment.enrollment_token,
                    code: projectMfaVerifyCode,
                }),
            })
            await readApiEnvelope(response, projectMfaVerifySchema)
            setProjectMfaEnrollment(null)
            setProjectMfaVerifyCode('')
            await fetchProjectUser()
        } catch (nextError) {
            setProjectAuthError((nextError as Error).message)
        } finally {
            setProjectMfaLoading(false)
        }
    }

    const handleDisableOwnMfa = async () => {
        setProjectMfaLoading(true)
        setProjectAuthError('')

        try {
            const response = await authenticatedProjectFetch(projectId, `${getApiUrl()}/api/v1/${projectId}/auth/mfa/totp/disable`, {
                method: 'POST',
            })
            const data = await readApiEnvelope(response, authUserSchema)
            setProjectUser(data)
            setProjectMfaEnrollment(null)
            setProjectMfaVerifyCode('')
        } catch (nextError) {
            setProjectAuthError((nextError as Error).message)
        } finally {
            setProjectMfaLoading(false)
        }
    }

    const handleInviteUser = async () => {
        if (!inviteEmail || !invitePassword) return
        setError('')

        try {
            const res = await authenticatedFetch(`${getApiUrl()}/api/v1/${projectId}/auth/users`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ email: inviteEmail, password: invitePassword }),
            })

            await readApiEnvelope(res, authUserSchema)
            setInviteEmail('')
            setInvitePassword('')
            setShowInvite(false)
            await fetchUsers()
        } catch (err) {
            setError((err as Error).message)
        }
    }

    const handleStartOAuth = async (provider: 'google' | 'github') => {
        setOauthLoading(provider)
        setError('')

        try {
            const res = await authenticatedFetch(`${getApiUrl()}/api/v1/${projectId}/auth/oauth/${provider}/start`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    redirectTo: `${window.location.origin}/auth/callback`,
                }),
            })
            const data = await res.json()

            if (!res.ok || !data.data?.url) {
                throw new Error(data.error?.message || `Failed to start ${provider} OAuth`)
            }

            window.location.href = data.data.url
        } catch (err) {
            setError((err as Error).message)
        } finally {
            setOauthLoading(null)
        }
    }

    return (
        <div className="shell py-8 md:py-10">
            <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
                <div>
                    <h1 className="text-3xl font-semibold tracking-[-0.04em] text-white">Authentication</h1>
                    <p className="mt-2 text-sm subtle">Manage providers, confirm users, revoke sessions, and keep MFA posture visible from one console.</p>
                </div>
                <div className="grid gap-3 sm:grid-cols-4">
                    <div className="panel-soft px-4 py-4">
                        <div className="text-xs uppercase tracking-[0.14em] subtle">Users</div>
                        <div className="mt-2 text-2xl font-semibold text-white">{summary.total}</div>
                    </div>
                    <div className="panel-soft px-4 py-4">
                        <div className="text-xs uppercase tracking-[0.14em] subtle">MFA enabled</div>
                        <div className="mt-2 text-2xl font-semibold text-white">{summary.mfa}</div>
                    </div>
                    <div className="panel-soft px-4 py-4">
                        <div className="text-xs uppercase tracking-[0.14em] subtle">Unconfirmed</div>
                        <div className="mt-2 text-2xl font-semibold text-white">{summary.unconfirmed}</div>
                    </div>
                    <div className="panel-soft px-4 py-4">
                        <div className="text-xs uppercase tracking-[0.14em] subtle">Disabled</div>
                        <div className="mt-2 text-2xl font-semibold text-white">{summary.disabled}</div>
                    </div>
                </div>
            </div>

            {error && (
                <div className="mt-6 rounded-[10px] border border-[rgba(239,111,108,0.25)] bg-[rgba(239,111,108,0.08)] px-4 py-3 text-sm text-[#f0b1af]">
                    {error}
                </div>
            )}

            <section className="panel-muted mt-6 p-6">
                <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                    <div>
                        <h2 className="text-lg font-semibold text-white">Project user session + MFA</h2>
                        <p className="mt-2 max-w-2xl text-sm leading-7 subtle">
                            Sign in as a project user to enroll TOTP MFA, verify setup, and disable it again without leaving the dashboard.
                        </p>
                    </div>
                    {projectUser && (
                        <button type="button" onClick={handleProjectSignOut} className="btn btn-secondary">
                            Sign out project user
                        </button>
                    )}
                </div>

                {projectAuthError && (
                    <div className="mt-5 rounded-[10px] border border-[rgba(239,111,108,0.25)] bg-[rgba(239,111,108,0.08)] px-4 py-3 text-sm text-[#f0b1af]">
                        {projectAuthError}
                    </div>
                )}

                {!projectUser ? (
                    <div className="mt-5 grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_220px_auto]">
                        <div>
                            <label htmlFor="project-auth-email" className="label">
                                Project user email
                            </label>
                            <input
                                id="project-auth-email"
                                type="email"
                                value={projectAuthEmail}
                                onChange={event => setProjectAuthEmail(event.target.value)}
                                placeholder="user@example.com"
                                className="input"
                            />
                        </div>
                        <div>
                            <label htmlFor="project-auth-password" className="label">
                                Password
                            </label>
                            <input
                                id="project-auth-password"
                                type="password"
                                value={projectAuthPassword}
                                onChange={event => setProjectAuthPassword(event.target.value)}
                                placeholder="Project password"
                                className="input"
                            />
                        </div>
                        <div>
                            <label htmlFor="project-auth-mfa" className="label">
                                MFA code
                            </label>
                            <input
                                id="project-auth-mfa"
                                value={projectAuthMfaCode}
                                onChange={event => setProjectAuthMfaCode(event.target.value)}
                                placeholder="Optional"
                                className="input"
                                inputMode="numeric"
                            />
                        </div>
                        <div className="flex items-end">
                            <button type="button" onClick={handleProjectSignIn} disabled={projectAuthLoading} className="btn btn-primary w-full">
                                {projectAuthLoading ? 'Signing in...' : 'Sign in'}
                            </button>
                        </div>
                    </div>
                ) : (
                    <div className="mt-5 grid gap-6 xl:grid-cols-[0.9fr_1.1fr]">
                        <div className="panel-soft p-5">
                            <div className="text-xs uppercase tracking-[0.14em] subtle">Current project user</div>
                            <div className="mt-3 text-lg font-semibold text-white">{projectUser.email}</div>
                            <div className="mt-2 font-mono text-xs subtle">{projectUser.id}</div>
                            <div className="mt-4 flex flex-wrap gap-2">
                                <span className={`status-badge ${projectUser.confirmed_at ? 'text-[color:var(--success)]' : 'text-[color:var(--warning)]'}`}>
                                    <span className="status-dot" />
                                    {projectUser.confirmed_at ? 'confirmed' : 'pending confirmation'}
                                </span>
                                <span className={`status-badge ${projectUser.totp_enabled ? 'text-[color:var(--success)]' : 'text-[color:var(--muted)]'}`}>
                                    <span className="status-dot" />
                                    {projectUser.totp_enabled ? 'mfa enabled' : 'mfa off'}
                                </span>
                            </div>
                        </div>

                        <div className="panel-soft p-5">
                            {!projectUser.totp_enabled ? (
                                <>
                                    <div className="flex items-center gap-3">
                                        <ShieldCheck className="h-5 w-5 text-[color:var(--accent)]" />
                                        <div>
                                            <div className="text-lg font-semibold text-white">Enroll TOTP MFA</div>
                                            <div className="mt-1 text-sm subtle">Start enrollment, add the secret to your authenticator app, then verify with a live code.</div>
                                        </div>
                                    </div>

                                    {!projectMfaEnrollment ? (
                                        <button type="button" onClick={handleStartMfaEnrollment} disabled={projectMfaLoading} className="btn btn-primary mt-5">
                                            {projectMfaLoading ? 'Preparing...' : 'Start enrollment'}
                                        </button>
                                    ) : (
                                        <div className="mt-5 space-y-4">
                                            <div className="panel px-4 py-4">
                                                <div className="text-xs uppercase tracking-[0.14em] subtle">Authenticator URI</div>
                                                <div className="mt-2 break-all text-xs text-white">{projectMfaEnrollment.uri}</div>
                                            </div>
                                            <div className="panel px-4 py-4">
                                                <div className="text-xs uppercase tracking-[0.14em] subtle">Secret</div>
                                                <div className="mt-2 font-mono text-sm text-white">{projectMfaEnrollment.secret}</div>
                                            </div>
                                            <div>
                                                <label htmlFor="project-mfa-verify" className="label">
                                                    Verification code
                                                </label>
                                                <input
                                                    id="project-mfa-verify"
                                                    value={projectMfaVerifyCode}
                                                    onChange={event => setProjectMfaVerifyCode(event.target.value)}
                                                    placeholder="123456"
                                                    className="input"
                                                    inputMode="numeric"
                                                />
                                            </div>
                                            <div className="flex gap-3">
                                                <button type="button" onClick={handleVerifyMfaEnrollment} disabled={projectMfaLoading} className="btn btn-primary">
                                                    {projectMfaLoading ? 'Verifying...' : 'Verify enrollment'}
                                                </button>
                                                <button
                                                    type="button"
                                                    onClick={() => {
                                                        setProjectMfaEnrollment(null)
                                                        setProjectMfaVerifyCode('')
                                                    }}
                                                    className="btn btn-secondary"
                                                >
                                                    Cancel
                                                </button>
                                            </div>
                                        </div>
                                    )}
                                </>
                            ) : (
                                <>
                                    <div className="flex items-center gap-3">
                                        <ShieldOff className="h-5 w-5 text-[color:var(--accent)]" />
                                        <div>
                                            <div className="text-lg font-semibold text-white">Disable TOTP MFA</div>
                                            <div className="mt-1 text-sm subtle">This removes the current authenticator secret for the signed-in project user.</div>
                                        </div>
                                    </div>

                                    <button type="button" onClick={handleDisableOwnMfa} disabled={projectMfaLoading} className="btn btn-danger mt-5">
                                        {projectMfaLoading ? 'Updating...' : 'Disable my MFA'}
                                    </button>
                                </>
                            )}
                        </div>
                    </div>
                )}
            </section>

            <div className="mt-6 grid gap-6 xl:grid-cols-[0.92fr_1.08fr]">
                <section className="panel p-6">
                    <div className="flex items-center gap-3">
                        <ShieldCheck className="h-5 w-5 text-[color:var(--accent)]" />
                        <div className="text-lg font-semibold text-white">Providers</div>
                    </div>
                    <div className="mt-5 divide-y divide-[color:var(--line)]">
                        {providerLoading && (
                            <div className="py-4 text-sm subtle">Loading providers...</div>
                        )}

                        {!providerLoading && providers.map(provider => (
                            <div key={provider.name} className="flex items-center justify-between py-4">
                                <div>
                                    <div className="font-medium text-white">{provider.name}</div>
                                    <div className="mt-1 text-sm subtle">
                                        {provider.enabled ? 'Enabled for this project.' : 'Not configured.'}
                                    </div>
                                </div>
                                <div className="flex items-center gap-3">
                                    <span className={`status-badge ${provider.enabled ? 'text-[color:var(--success)]' : 'text-[color:var(--muted)]'}`}>
                                        <span className="status-dot" />
                                        {provider.enabled ? 'enabled' : 'disabled'}
                                    </span>
                                    {(provider.key === 'google' || provider.key === 'github') && provider.enabled && (
                                        <button
                                            type="button"
                                            onClick={() => handleStartOAuth(provider.key === 'google' ? 'google' : 'github')}
                                            disabled={oauthLoading === provider.key}
                                            className="btn btn-secondary"
                                        >
                                            {oauthLoading === provider.key ? 'Starting...' : 'Start OAuth'}
                                        </button>
                                    )}
                                </div>
                            </div>
                        ))}
                    </div>
                </section>

                <section className="panel overflow-hidden">
                    <div className="panel-header flex flex-col gap-4 px-6 py-4 md:flex-row md:items-center md:justify-between">
                        <div>
                            <div className="text-lg font-semibold text-white">User management</div>
                            <div className="mt-1 text-sm subtle">Project-scoped auth identities with admin controls for confirmation, recovery, disablement, and MFA reset.</div>
                        </div>
                        <button type="button" onClick={() => setShowInvite(true)} className="btn btn-primary">
                            <Plus className="h-4 w-4" />
                            Add user
                        </button>
                    </div>

                    {showInvite && (
                        <div className="border-b border-[color:var(--line)] bg-[rgba(255,255,255,0.02)] px-6 py-5">
                            <div className="grid gap-4 md:grid-cols-2">
                                <div>
                                    <label htmlFor="invite-email" className="label">
                                        Email
                                    </label>
                                    <input
                                        id="invite-email"
                                        type="email"
                                        value={inviteEmail}
                                        onChange={e => setInviteEmail(e.target.value)}
                                        placeholder="user@example.com"
                                        className="input"
                                    />
                                </div>
                                <div>
                                    <label htmlFor="invite-password" className="label">
                                        Temporary password
                                    </label>
                                    <input
                                        id="invite-password"
                                        type="password"
                                        value={invitePassword}
                                        onChange={e => setInvitePassword(e.target.value)}
                                        placeholder="At least 8 characters"
                                        className="input"
                                    />
                                </div>
                            </div>
                            <div className="mt-4 flex gap-3">
                                <button type="button" onClick={handleInviteUser} className="btn btn-primary">
                                    Create user
                                </button>
                                <button
                                    type="button"
                                    onClick={() => {
                                        setShowInvite(false)
                                        setError('')
                                    }}
                                    className="btn btn-secondary"
                                >
                                    Cancel
                                </button>
                            </div>
                        </div>
                    )}

                    {loading ? (
                        <div className="empty-state">
                            <p className="text-sm subtle">Loading users...</p>
                        </div>
                    ) : users.length === 0 ? (
                        <div className="empty-state">
                            <div className="max-w-md">
                                <Users className="mx-auto h-10 w-10 text-[color:var(--accent)]" />
                                <div className="mt-4 text-xl font-semibold text-white">No users yet</div>
                                <p className="mt-3 text-sm leading-7 subtle">
                                    Users appear here after sign-up or after you create them from this console.
                                </p>
                            </div>
                        </div>
                    ) : (
                        <div className="divide-y divide-[color:var(--line)]">
                            {users.map(user => {
                                const busy = actionUserId === user.id
                                const confirmed = Boolean(user.confirmed_at)
                                const disabled = Boolean(user.disabled_at)

                                return (
                                    <article key={user.id} className="px-6 py-5">
                                        <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
                                            <div className="min-w-0">
                                                <div className="truncate text-base font-semibold text-white">{user.email}</div>
                                                <div className="mt-2 font-mono text-xs subtle">{user.id}</div>
                                                <div className="mt-3 flex flex-wrap gap-2">
                                                    <span className={`status-badge ${confirmed ? 'text-[color:var(--success)]' : 'text-[color:var(--warning)]'}`}>
                                                        <span className="status-dot" />
                                                        {confirmed ? 'confirmed' : 'pending confirmation'}
                                                    </span>
                                                    <span className={`status-badge ${disabled ? 'text-[color:var(--danger)]' : 'text-[color:var(--accent)]'}`}>
                                                        <span className="status-dot" />
                                                        {disabled ? 'disabled' : 'active'}
                                                    </span>
                                                    <span className={`status-badge ${user.totp_enabled ? 'text-[color:var(--success)]' : 'text-[color:var(--muted)]'}`}>
                                                        <span className="status-dot" />
                                                        {user.totp_enabled ? 'mfa enabled' : 'mfa off'}
                                                    </span>
                                                </div>
                                                <div className="mt-3 text-xs subtle">
                                                    Last sign-in {user.last_sign_in_at ? new Date(user.last_sign_in_at).toLocaleString() : 'never'}
                                                </div>
                                                {user.disabled_reason && (
                                                    <div className="mt-2 text-xs text-[#f0b1af]">{user.disabled_reason}</div>
                                                )}
                                            </div>

                                            <div className="flex flex-wrap gap-2">
                                                {!confirmed && (
                                                    <button
                                                        type="button"
                                                        onClick={() => void runUserAction(user.id, {
                                                            path: `/auth/users/${user.id}/confirm`,
                                                            method: 'POST',
                                                        })}
                                                        disabled={busy}
                                                        className="btn btn-secondary h-9 min-h-0 px-3"
                                                    >
                                                        <CheckCircle2 className="h-4 w-4" />
                                                        Confirm
                                                    </button>
                                                )}
                                                <button
                                                    type="button"
                                                    onClick={() => void runUserAction(user.id, {
                                                        path: `/auth/users/${user.id}/password-reset`,
                                                        method: 'POST',
                                                    })}
                                                    disabled={busy}
                                                    className="btn btn-secondary h-9 min-h-0 px-3"
                                                >
                                                    <Mail className="h-4 w-4" />
                                                    Reset email
                                                </button>
                                                <button
                                                    type="button"
                                                    onClick={() => void runUserAction(user.id, {
                                                        path: `/auth/users/${user.id}/revoke-sessions`,
                                                        method: 'POST',
                                                    })}
                                                    disabled={busy}
                                                    className="btn btn-secondary h-9 min-h-0 px-3"
                                                >
                                                    <RotateCcw className="h-4 w-4" />
                                                    Revoke sessions
                                                </button>
                                                {user.totp_enabled && (
                                                    <button
                                                        type="button"
                                                        onClick={() => void runUserAction(user.id, {
                                                            path: `/auth/users/${user.id}/mfa/totp/disable`,
                                                            method: 'POST',
                                                        })}
                                                        disabled={busy}
                                                        className="btn btn-secondary h-9 min-h-0 px-3"
                                                    >
                                                        <ShieldOff className="h-4 w-4" />
                                                        Disable MFA
                                                    </button>
                                                )}
                                                <button
                                                    type="button"
                                                    onClick={() => void runUserAction(user.id, {
                                                        path: `/auth/users/${user.id}`,
                                                        method: 'PATCH',
                                                        headers: { 'Content-Type': 'application/json' },
                                                        body: JSON.stringify({
                                                            disabled: !disabled,
                                                            reason: disabled ? undefined : 'Disabled from the OpenBase dashboard',
                                                        }),
                                                    })}
                                                    disabled={busy}
                                                    className={disabled ? 'btn btn-secondary h-9 min-h-0 px-3' : 'btn btn-danger h-9 min-h-0 px-3'}
                                                >
                                                    {disabled ? <Ban className="h-4 w-4" /> : <KeyRound className="h-4 w-4" />}
                                                    {disabled ? 'Re-enable' : 'Disable'}
                                                </button>
                                                <button
                                                    type="button"
                                                    onClick={() => void runUserAction(user.id, {
                                                        path: `/auth/users/${user.id}`,
                                                        method: 'DELETE',
                                                    })}
                                                    disabled={busy}
                                                    className="btn btn-danger h-9 min-h-0 px-3"
                                                >
                                                    <Trash2 className="h-4 w-4" />
                                                    Delete
                                                </button>
                                            </div>
                                        </div>
                                    </article>
                                )
                            })}
                        </div>
                    )}
                </section>
            </div>
        </div>
    )
}
