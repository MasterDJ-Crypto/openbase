'use client'

import { useEffect, useMemo, useState } from 'react'
import { useParams } from 'next/navigation'
import { Braces, FileClock, Layers3, TerminalSquare } from 'lucide-react'
import { schemaExportSchema } from '@openbase/core'
import { authenticatedFetch, getApiUrl, readApiEnvelope } from '../../../../lib/platformApi'

export default function MigrationsPage() {
    const params = useParams()
    const projectId = params.projectId as string
    const [state, setState] = useState<{
        projectId: string
        projectName: string
        tables: Record<string, {
            tableName: string
            columns: Array<{ name: string; type: string; required?: boolean; unique?: boolean; encrypted?: boolean }>
            indexes: string[]
            rls?: Array<{ operation: string; check: string }>
        }>
        migrations: Array<{
            name: string
            description?: string
            checksum: string
            direction: 'up' | 'down'
            source: 'cli' | 'dashboard' | 'sdk'
            appliedAt: string
            operations: number
        }>
        appliedMigrations: string[]
    } | null>(null)
    const [error, setError] = useState('')

    useEffect(() => {
        const run = async () => {
            try {
                const response = await authenticatedFetch(`${getApiUrl()}/api/v1/${projectId}/schema/export`)
                const data = await readApiEnvelope(response, schemaExportSchema)
                setState(data)
            } catch (nextError) {
                setError((nextError as Error).message)
            }
        }

        void run()
    }, [projectId])

    const tableEntries = useMemo(() => Object.entries(state?.tables || {}).sort(([left], [right]) => left.localeCompare(right)), [state])

    return (
        <div className="shell py-8 md:py-10">
            <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
                <div>
                    <h1 className="text-3xl font-semibold tracking-[-0.04em] text-white">Migrations</h1>
                    <p className="mt-2 max-w-2xl text-sm leading-7 subtle">
                        Track schema drift, inspect the ordered migration chain, and generate typed clients from the
                        live project schema.
                    </p>
                </div>
                <div className="panel-soft flex items-center gap-3 px-4 py-3">
                    <FileClock className="h-4 w-4 text-[color:var(--accent)]" />
                    <div>
                        <div className="text-xs font-medium subtle">Applied</div>
                        <div className="text-sm text-white">{state?.appliedMigrations.length ?? 0} migrations</div>
                    </div>
                </div>
            </div>

            {error && (
                <div className="mt-6 rounded-[10px] border border-[rgba(239,111,108,0.25)] bg-[rgba(239,111,108,0.08)] px-4 py-3 text-sm text-[#f0b1af]">
                    {error}
                </div>
            )}

            <section className="panel mt-6 p-6">
                <div className="grid gap-4 lg:grid-cols-[0.9fr_1.1fr]">
                    <div className="panel-soft p-5">
                        <div className="flex items-center gap-3">
                            <TerminalSquare className="h-5 w-5 text-[color:var(--accent)]" />
                            <div className="text-lg font-semibold text-white">CLI flow</div>
                        </div>
                        <div className="code-panel mt-4 p-5 text-sm leading-8">
                            <div>openbase init --project-id {projectId}</div>
                            <div>openbase migration new add_posts_table</div>
                            <div>openbase migration run</div>
                            <div>openbase gen types --out ./openbase/generated.ts</div>
                        </div>
                    </div>

                    <div className="grid gap-4 sm:grid-cols-2">
                        <div className="panel-soft p-5">
                            <div className="flex items-center gap-3">
                                <Layers3 className="h-5 w-5 text-[color:var(--accent)]" />
                                <div>
                                    <div className="text-xs font-medium subtle">Tables</div>
                                    <div className="mt-2 text-2xl font-semibold text-white">{tableEntries.length}</div>
                                </div>
                            </div>
                        </div>
                        <div className="panel-soft p-5">
                            <div className="flex items-center gap-3">
                                <Braces className="h-5 w-5 text-[color:var(--accent)]" />
                                <div>
                                    <div className="text-xs font-medium subtle">Latest migration</div>
                                    <div className="mt-2 text-sm text-white">
                                        {state?.migrations.at(-1)?.name || 'No migrations yet'}
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            </section>

            <div className="mt-6 grid gap-6 xl:grid-cols-[0.95fr_1.05fr]">
                <section className="panel overflow-hidden">
                    <div className="panel-header px-6 py-4">
                        <div className="text-lg font-semibold text-white">Migration history</div>
                        <div className="mt-1 text-sm subtle">Every apply and rollback event, ordered exactly as recorded.</div>
                    </div>

                    {state?.migrations.length ? (
                        <div className="divide-y divide-[color:var(--line)]">
                            {state.migrations.map(entry => (
                                <div key={`${entry.name}-${entry.appliedAt}-${entry.direction}`} className="grid gap-4 px-6 py-5 md:grid-cols-[minmax(0,1fr)_120px_120px_160px]">
                                    <div className="min-w-0">
                                        <div className="truncate text-base font-semibold text-white">{entry.name}</div>
                                        <div className="mt-2 text-xs subtle">{entry.description || 'No description supplied.'}</div>
                                        <div className="mt-3 font-mono text-[11px] subtle">{entry.checksum}</div>
                                    </div>
                                    <div>
                                        <div className="text-xs font-medium subtle">Direction</div>
                                        <div className={`status-badge mt-2 ${entry.direction === 'up' ? 'text-[color:var(--success)]' : 'text-[color:var(--warning)]'}`}>
                                            <span className="status-dot" />
                                            {entry.direction}
                                        </div>
                                    </div>
                                    <div>
                                        <div className="text-xs font-medium subtle">Source</div>
                                        <div className="mt-2 text-sm capitalize text-white">{entry.source}</div>
                                    </div>
                                    <div>
                                        <div className="text-xs font-medium subtle">Applied</div>
                                        <div className="mt-2 text-sm text-white">{new Date(entry.appliedAt).toLocaleString()}</div>
                                        <div className="mt-1 text-xs subtle">{entry.operations} operations</div>
                                    </div>
                                </div>
                            ))}
                        </div>
                    ) : (
                        <div className="empty-state">
                            <div className="max-w-md">
                                <FileClock className="mx-auto h-10 w-10 text-[color:var(--accent)]" />
                                <div className="mt-4 text-xl font-semibold text-white">No migration history yet</div>
                                <p className="mt-3 text-sm leading-7 subtle">
                                    Create a local migration file and run it through the OpenBase CLI to start recording history.
                                </p>
                            </div>
                        </div>
                    )}
                </section>

                <section className="panel overflow-hidden">
                    <div className="panel-header px-6 py-4">
                        <div className="text-lg font-semibold text-white">Live schema export</div>
                        <div className="mt-1 text-sm subtle">Current table shape as seen by the API and type generator.</div>
                    </div>

                    {tableEntries.length ? (
                        <div className="grid gap-4 p-6">
                            {tableEntries.map(([tableName, schema]) => (
                                <article key={tableName} className="panel-soft p-5">
                                    <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
                                        <div>
                                            <div className="text-lg font-semibold text-white">{tableName}</div>
                                            <div className="mt-1 text-sm subtle">
                                                {schema.columns.length} columns, {schema.indexes.length} indexes
                                            </div>
                                        </div>
                                        <div className="text-xs subtle">
                                            {schema.rls?.length ? `${schema.rls.length} RLS policies` : 'No RLS policies'}
                                        </div>
                                    </div>

                                    <div className="mt-5 grid gap-2">
                                        {schema.columns.map(column => (
                                            <div key={column.name} className="flex flex-wrap items-center gap-2 rounded-[10px] border border-[color:var(--line)] bg-[rgba(255,255,255,0.03)] px-3 py-3">
                                                <code className="text-sm text-white">{column.name}</code>
                                                <span className="rounded-full border border-[color:var(--line)] px-2 py-1 text-[11px] uppercase tracking-[0.2em] subtle">
                                                    {column.type}
                                                </span>
                                                {column.required && <span className="text-[11px] text-[color:var(--warning)]">required</span>}
                                                {column.unique && <span className="text-[11px] text-[color:var(--success)]">unique</span>}
                                                {column.encrypted && <span className="text-[11px] text-[#f0b1af]">encrypted</span>}
                                            </div>
                                        ))}
                                    </div>

                                    {schema.indexes.length > 0 && (
                                        <div className="mt-4 text-sm subtle">
                                            Indexes: <span className="text-white">{schema.indexes.join(', ')}</span>
                                        </div>
                                    )}
                                </article>
                            ))}
                        </div>
                    ) : (
                        <div className="empty-state">
                            <div className="max-w-md">
                                <Layers3 className="mx-auto h-10 w-10 text-[color:var(--accent)]" />
                                <div className="mt-4 text-xl font-semibold text-white">No tables exported yet</div>
                                <p className="mt-3 text-sm leading-7 subtle">
                                    The schema export fills in once the project has at least one table and the migration engine begins tracking changes.
                                </p>
                            </div>
                        </div>
                    )}
                </section>
            </div>
        </div>
    )
}
