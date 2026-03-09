'use client'

import Link from 'next/link'
import { useParams, usePathname, useRouter } from 'next/navigation'
import { useEffect, useState } from 'react'
import {
    Activity,
    ArrowLeft,
    Database,
    FileCode2,
    FolderOpen,
    LayoutDashboard,
    ScrollText,
    Settings,
    Shield,
} from 'lucide-react'
import { AppLogo } from '../../../components/AppLogo'
import { authenticatedFetch, hasPlatformSession } from '../../../lib/platformApi'

interface Project {
    id: string
    name: string
    status: 'warming_up' | 'active' | 'suspended' | 'warmup_failed'
    channelMap: Record<string, { id: string; accessHash: string }>
    buckets: Record<string, { id: string; accessHash: string }>
}

const navItems = [
    { label: 'Overview', path: '', icon: LayoutDashboard },
    { label: 'Table editor', path: '/editor', icon: Database },
    { label: 'Migrations', path: '/migrations', icon: FileCode2 },
    { label: 'Auth', path: '/auth', icon: Shield },
    { label: 'Storage', path: '/storage', icon: FolderOpen },
    { label: 'Realtime', path: '/realtime', icon: Activity },
    { label: 'Settings', path: '/settings', icon: Settings },
    { label: 'Logs', path: '/logs', icon: ScrollText },
]

const statusTone: Record<Project['status'], string> = {
    active: 'text-[color:var(--success)]',
    warming_up: 'text-[color:var(--warning)]',
    suspended: 'text-[color:var(--danger)]',
    warmup_failed: 'text-[color:var(--danger)]',
}

export default function ProjectLayout({ children }: { children: React.ReactNode }) {
    const params = useParams()
    const pathname = usePathname()
    const router = useRouter()
    const projectId = params.projectId as string
    const [project, setProject] = useState<Project | null>(null)

    useEffect(() => {
        if (!hasPlatformSession()) {
            router.push('/login')
            return
        }

        const apiUrl = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001'
        authenticatedFetch(`${apiUrl}/api/v1/projects/${projectId}`)
            .then(response => response.json())
            .then(data => setProject(data.data || null))
            .catch(() => setProject(null))
    }, [projectId, router])

    return (
        <div className="project-shell">
            <aside className="border-b border-[color:var(--line)] bg-[rgba(12,16,14,0.88)] lg:border-b-0 lg:border-r">
                <div className="p-5">
                    <AppLogo href="/dashboard" subtitle="Project workspace" />

                    <Link href="/dashboard" className="mt-6 inline-flex items-center gap-2 text-sm subtle hover:text-white">
                        <ArrowLeft className="h-4 w-4" />
                        All projects
                    </Link>

                    <div className="mt-6 rounded-[10px] border border-[color:var(--line)] bg-[rgba(255,255,255,0.02)] p-4">
                        <div className="truncate text-lg font-semibold text-white">
                            {project?.name || 'Loading project'}
                        </div>
                        <div className="mt-2 font-mono text-xs subtle">{projectId}</div>
                        <div className={`status-badge mt-4 ${statusTone[project?.status || 'warming_up']}`}>
                            <span className="status-dot" />
                            {(project?.status || 'warming_up').replace('_', ' ')}
                        </div>
                    </div>
                </div>

                <nav className="flex gap-2 overflow-x-auto px-5 pb-5 lg:block lg:space-y-1 lg:overflow-visible">
                    {navItems.map(item => {
                        const href = `/dashboard/${projectId}${item.path}`
                        const isActive = pathname === href || (item.path === '' && pathname === `/dashboard/${projectId}`)
                        const Icon = item.icon

                        return (
                            <Link
                                key={item.path}
                                href={href}
                                className="sidebar-link min-w-max lg:min-w-0"
                                data-active={isActive}
                            >
                                <Icon className="h-4 w-4" />
                                {item.label}
                            </Link>
                        )
                    })}
                </nav>
            </aside>

            <main className="min-w-0">
                {children}
            </main>
        </div>
    )
}
