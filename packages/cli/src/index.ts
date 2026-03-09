#!/usr/bin/env node

import { spawn, spawnSync } from 'child_process'
import { createHash } from 'crypto'
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { readdir, stat, writeFile } from 'fs/promises'
import { dirname, join, resolve } from 'path'
import type { MigrationDefinition, SchemaExport } from '@openbase/core'
import { migrationDefinitionSchema } from '@openbase/core'
import { createAdminClient, generateTypescriptSchemaClient } from 'openbase-js'

interface OpenBaseConfig {
    apiUrl: string
    projectId: string
    serviceRoleKey: string
    migrationsDir: string
    typesOutput: string
    schemaOutput: string
    seedFile: string
}

interface LocalRuntimeState {
    mode: 'compose' | 'process'
    startedAt: string
    workdir: string
    pid?: number
    pids?: number[]
    stdoutPath?: string
    stderrPath?: string
    envFilePath?: string
    projectName?: string
}

interface LoadedConfig {
    config: OpenBaseConfig
    configPath: string
}

interface SeedFile {
    tables?: Record<string, Record<string, unknown>[]>
    [tableName: string]: unknown
}

type MigrationFile = MigrationDefinition

const DEFAULT_CONFIG: OpenBaseConfig = {
    apiUrl: 'http://localhost:3001',
    projectId: 'your-project-id',
    serviceRoleKey: 'your-service-role-key',
    migrationsDir: 'openbase/migrations',
    typesOutput: 'openbase/generated.ts',
    schemaOutput: 'openbase/schema-export.json',
    seedFile: 'openbase/seed.json',
}

async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
    const [command, subcommand, ...rest] = argv

    if (command === 'init') {
        await handleInit(parseFlags([subcommand, ...rest]))
        return
    }

    if (command === 'status') {
        await handleStatus(parseFlags([subcommand, ...rest]))
        return
    }

    if (command === 'start') {
        await handleStart(parseFlags([subcommand, ...rest]))
        return
    }

    if (command === 'stop') {
        await handleStop(parseFlags([subcommand, ...rest]))
        return
    }

    if (command === 'seed') {
        await handleSeed(parseFlags([subcommand, ...rest]))
        return
    }

    switch (`${command ?? ''} ${subcommand ?? ''}`.trim()) {
        case 'gen types':
            await handleGenerateTypes(parseFlags(rest))
            return
        case 'migration new':
            await handleMigrationNew(rest[0], parseFlags(rest.slice(1)))
            return
        case 'migration run':
            await handleMigrationRun(parseFlags(rest))
            return
        case 'migration rollback':
            await handleMigrationRollback(
                rest[0]?.startsWith('--') ? undefined : rest[0],
                parseFlags(rest[0]?.startsWith('--') ? rest : rest.slice(1))
            )
            return
        case 'db push':
            await handleDbPush(parseFlags(rest))
            return
        case 'db pull':
            await handleDbPull(parseFlags(rest))
            return
        case 'db reset':
            await handleDbReset(parseFlags(rest))
            return
        default:
            printUsage()
            process.exitCode = 1
    }
}

function parseFlags(args: string[]) {
    const flags: Record<string, string> = {}
    for (let index = 0; index < args.length; index++) {
        const current = args[index]
        if (!current?.startsWith('--')) {
            continue
        }

        const key = current.slice(2)
        const next = args[index + 1]
        if (!next || next.startsWith('--')) {
            flags[key] = 'true'
            continue
        }

        flags[key] = next
        index += 1
    }

    return flags
}

async function handleInit(flags: Record<string, string>): Promise<void> {
    const configPath = resolve(flags.config || 'openbase.config.json')
    const configDir = dirname(configPath)
    mkdirSync(configDir, { recursive: true })
    if (existsSync(configPath) && flags.force !== 'true') {
        throw new Error(`Config already exists at ${configPath}. Pass --force true to overwrite.`)
    }

    const serviceRoleKey = flags['service-role-key'] || DEFAULT_CONFIG.serviceRoleKey
    const derivedProjectId = serviceRoleKey !== DEFAULT_CONFIG.serviceRoleKey
        ? extractProjectIdFromToken(serviceRoleKey)
        : ''

    const config: OpenBaseConfig = {
        apiUrl: flags['api-url'] || DEFAULT_CONFIG.apiUrl,
        projectId: flags['project-id'] || derivedProjectId || DEFAULT_CONFIG.projectId,
        serviceRoleKey,
        migrationsDir: flags['migrations-dir'] || DEFAULT_CONFIG.migrationsDir,
        typesOutput: flags['types-output'] || DEFAULT_CONFIG.typesOutput,
        schemaOutput: flags['schema-output'] || DEFAULT_CONFIG.schemaOutput,
        seedFile: flags['seed-file'] || DEFAULT_CONFIG.seedFile,
    }

    writeJson(configPath, config)
    mkdirSync(resolveFromConfig(configPath, config.migrationsDir), { recursive: true })
    mkdirSync(dirname(resolveFromConfig(configPath, config.typesOutput)), { recursive: true })
    mkdirSync(dirname(resolveFromConfig(configPath, config.schemaOutput)), { recursive: true })
    mkdirSync(dirname(resolveFromConfig(configPath, config.seedFile)), { recursive: true })
    const seedPath = resolveFromConfig(configPath, config.seedFile)
    if (!existsSync(seedPath)) {
        writeJson(seedPath, { tables: {} })
    }

    const healthUrl = `${config.apiUrl.replace(/\/$/, '')}/health`
    try {
        const response = await fetch(healthUrl)
        console.log(`Initialized OpenBase config at ${configPath}`)
        console.log(`API health check: ${response.ok ? 'ok' : `HTTP ${response.status}`}`)
    } catch {
        console.log(`Initialized OpenBase config at ${configPath}`)
        console.log(`API health check skipped: ${healthUrl} was not reachable during init`)
    }
}

async function handleStatus(flags: Record<string, string>): Promise<void> {
    const loaded = loadConfig(flags.config)
    const runtime = readRuntimeState(loaded.configPath)
    const composeWorkdir = runtime?.workdir || findWorkspaceRoot(process.cwd())
    const composeProjectName = runtime?.projectName || getComposeProjectName(loaded.configPath)
    const composeEnvPath = runtime?.envFilePath || ensureComposeEnvFile(loaded)
    const composeServices = composeWorkdir && dockerComposeAvailable()
        ? readComposeServices(composeWorkdir, composeProjectName, composeEnvPath)
        : []
    const composeRunning = composeServices.some(service => service.state.toLowerCase() === 'running')
    const processPids = runtime?.mode === 'process'
        ? runtime.pids ?? (runtime.pid ? [runtime.pid] : [])
        : []
    const processRunning = processPids.some(pid => getProcessStatus(pid) === 'running')
    const localStatus = runtime?.mode === 'process'
        ? processRunning ? 'running' : 'stopped'
        : composeRunning ? 'running' : 'stopped'

    console.log(`Config: ${loaded.configPath}`)
    console.log(`API URL: ${loaded.config.apiUrl}`)
    console.log(`Project ID: ${loaded.config.projectId}`)
    console.log(`Local runtime: ${localStatus}`)
    if (runtime?.mode === 'process' && processPids.length > 0) {
        console.log(`  PIDs: ${processPids.join(', ')}`)
        console.log(`  Started: ${runtime.startedAt}`)
        if (runtime.stdoutPath) {
            console.log(`  Logs: ${runtime.stdoutPath}`)
        }
    }
    if (composeServices.length > 0) {
        console.log(`  Compose project: ${composeProjectName}`)
        for (const service of composeServices) {
            const health = service.health ? ` (${service.health})` : ''
            console.log(`  ${service.service}: ${service.state}${health}`)
        }
    }

    if (!hasConfiguredServiceRoleKey(loaded.config.serviceRoleKey)) {
        console.log('Remote project status skipped: configure serviceRoleKey to query schema and migrations.')
        return
    }

    const client = createAdminClient(loaded.config.apiUrl, loaded.config.serviceRoleKey)
    const healthPromise = fetch(`${loaded.config.apiUrl.replace(/\/$/, '')}/health`).catch(() => null)
    const [healthResponse, schema, migrations] = await Promise.all([
        healthPromise,
        client.admin.schema.export(),
        client.admin.migrations.list(),
    ])

    if (schema.error) {
        throw new Error(schema.error.message)
    }
    if (migrations.error) {
        throw new Error(migrations.error.message)
    }

    const healthLabel = healthResponse
        ? `${healthResponse.ok ? 'ok' : `HTTP ${healthResponse.status}`}`
        : 'unreachable'

    console.log(`Remote API health: ${healthLabel}`)
    console.log(`Remote project: ${schema.data?.projectName} (${schema.data?.projectId})`)
    console.log(`Remote tables: ${Object.keys(schema.data?.tables || {}).length}`)
    console.log(`Applied migrations: ${migrations.data?.appliedMigrations.length || 0}`)
}

async function handleStart(flags: Record<string, string>): Promise<void> {
    const loaded = loadConfig(flags.config)
    const runtime = readRuntimeState(loaded.configPath)
    const workdir = flags.workdir ? resolve(flags.workdir) : findWorkspaceRoot(process.cwd())
    if (!workdir) {
        throw new Error('Unable to locate the OpenBase workspace root. Pass --workdir <path> to start it explicitly.')
    }

    const projectName = runtime?.projectName || getComposeProjectName(loaded.configPath)
    const envFilePath = ensureComposeEnvFile(loaded)
    const existingServices = dockerComposeAvailable()
        ? readComposeServices(workdir, projectName, envFilePath)
        : []
    if (existingServices.some(service => service.state.toLowerCase() === 'running')) {
        console.log(`OpenBase is already running via Docker Compose (${projectName}).`)
        for (const service of existingServices) {
            const health = service.health ? ` (${service.health})` : ''
            console.log(`  ${service.service}: ${service.state}${health}`)
        }
        return
    }

    if (dockerComposeAvailable()) {
        try {
            runComposeCommand(
                workdir,
                projectName,
                envFilePath,
                ['up', '-d', '--wait', 'redis', 'api', 'dashboard']
            )

            const state: LocalRuntimeState = {
                mode: 'compose',
                startedAt: new Date().toISOString(),
                workdir,
                envFilePath,
                projectName,
            }

            writeRuntimeState(loaded.configPath, state)
            console.log(`Started OpenBase via Docker Compose from ${workdir}`)
            console.log(`Compose project: ${projectName}`)
            return
        } catch (error) {
            console.warn(`Docker Compose startup failed, falling back to local process mode: ${(error as Error).message}`)
        }
    }

    const runtimeDir = getRuntimeDir(loaded.configPath)
    mkdirSync(runtimeDir, { recursive: true })
    const stdoutPath = join(runtimeDir, 'api.start.out.log')
    const stderrPath = join(runtimeDir, 'api.start.err.log')
    const dashboardStdoutPath = join(runtimeDir, 'dashboard.start.out.log')
    const dashboardStderrPath = join(runtimeDir, 'dashboard.start.err.log')
    const processEnvPath = ensureProcessEnvFile(loaded)
    const stdoutFd = writeLogFile(stdoutPath)
    const stderrFd = writeLogFile(stderrPath)
    const dashboardStdoutFd = writeLogFile(dashboardStdoutPath)
    const dashboardStderrFd = writeLogFile(dashboardStderrPath)
    const apiChild = spawn(process.execPath, ['dist/index.js'], {
        cwd: join(workdir, 'apps/api'),
        detached: true,
        stdio: ['ignore', stdoutFd, stderrFd],
        windowsHide: true,
        env: buildApiProcessEnv(loaded.config, processEnvPath),
    })
    const dashboardChild = spawn(
        process.execPath,
        [resolveDashboardCli(workdir), 'start', '--hostname', '127.0.0.1', '--port', '3000'],
        {
            cwd: join(workdir, 'apps/dashboard'),
            detached: true,
            stdio: ['ignore', dashboardStdoutFd, dashboardStderrFd],
            windowsHide: true,
            env: buildDashboardProcessEnv(loaded.config),
        }
    )

    apiChild.unref()
    dashboardChild.unref()

    const processState: LocalRuntimeState = {
        mode: 'process',
        startedAt: new Date().toISOString(),
        workdir,
        pid: apiChild.pid ?? 0,
        pids: [apiChild.pid ?? 0, dashboardChild.pid ?? 0].filter(pid => pid > 0),
        stdoutPath,
        stderrPath,
        envFilePath: processEnvPath,
    }

    writeRuntimeState(loaded.configPath, processState)
    try {
        await waitForLocalStack(processState.pids ?? [])
    } catch (error) {
        deleteRuntimeState(loaded.configPath)
        for (const pid of processState.pids ?? []) {
            stopProcess(pid)
        }
        throw error
    }

    console.log(`Started OpenBase locally from ${workdir}`)
    console.log(`PID: ${processState.pid}`)
    console.log(`Logs: ${stdoutPath}`)
}

async function handleStop(flags: Record<string, string>): Promise<void> {
    const loaded = loadConfig(flags.config)
    const runtime = readRuntimeState(loaded.configPath)
    const workdir = flags.workdir
        ? resolve(flags.workdir)
        : runtime?.workdir || findWorkspaceRoot(process.cwd())
    if (!workdir) {
        throw new Error('Unable to locate the OpenBase workspace root. Pass --workdir <path> to stop it explicitly.')
    }

    if (runtime?.mode === 'process' && runtime.pid) {
        const pids = runtime.pids ?? [runtime.pid]
        const runningPids = pids.filter(pid => getProcessStatus(pid) === 'running')
        if (runningPids.length === 0) {
            deleteRuntimeState(loaded.configPath)
            console.log('OpenBase process was not running. Cleared stale runtime state.')
            return
        }

        for (const pid of runningPids) {
            stopProcess(pid)
        }
        deleteRuntimeState(loaded.configPath)
        console.log(`Stopped OpenBase process mode (${runningPids.join(', ')}).`)
        return
    }

    const projectName = runtime?.projectName || getComposeProjectName(loaded.configPath)
    const envFilePath = runtime?.envFilePath || ensureComposeEnvFile(loaded)
    if (!dockerComposeAvailable()) {
        throw new Error('Docker Compose is required for `openbase stop`.')
    }

    runComposeCommand(workdir, projectName, envFilePath, ['down'])
    deleteRuntimeState(loaded.configPath)
    console.log(`Stopped OpenBase Docker Compose stack (${projectName}).`)
}

async function handleGenerateTypes(flags: Record<string, string>): Promise<void> {
    const loaded = loadConfig(flags.config)
    const outputPath = resolveFromConfig(loaded.configPath, flags.out || loaded.config.typesOutput)
    const schema = await fetchSchemaExport(loaded.config)

    mkdirSync(dirname(outputPath), { recursive: true })
    await writeFile(outputPath, generateTypescriptSchemaClient(schema))
    console.log(`Wrote generated client types to ${outputPath}`)
}

async function handleMigrationNew(name: string | undefined, flags: Record<string, string>): Promise<void> {
    if (!name) {
        throw new Error('Migration name is required')
    }

    const loaded = loadConfig(flags.config)
    const migrationsDir = resolveFromConfig(loaded.configPath, loaded.config.migrationsDir)
    mkdirSync(migrationsDir, { recursive: true })
    const timestamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14)
    const slug = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
    const filePath = resolve(migrationsDir, `${timestamp}_${slug}.json`)
    const template = {
        name: `${timestamp}_${slug}`,
        description: '',
        up: [
            {
                type: 'add_column',
                tableName: 'your_table',
                column: {
                    name: 'new_column',
                    type: 'text',
                },
            },
        ],
        down: [
            {
                type: 'remove_column',
                tableName: 'your_table',
                columnName: 'new_column',
            },
        ],
    }

    await writeFile(filePath, `${JSON.stringify(template, null, 2)}\n`)
    console.log(`Created migration template at ${filePath}`)
}

async function handleMigrationRun(flags: Record<string, string>): Promise<void> {
    const loaded = loadConfig(flags.config)
    await runPendingMigrations(loaded)
}

async function handleMigrationRollback(name: string | undefined, flags: Record<string, string>): Promise<void> {
    const loaded = loadConfig(flags.config)
    const client = createAdminClient(loaded.config.apiUrl, loaded.config.serviceRoleKey)
    const [localFiles, remote] = await Promise.all([
        readMigrationFiles(loaded),
        client.admin.migrations.list(),
    ])

    if (remote.error || !remote.data) {
        throw new Error(remote.error?.message || 'Failed to list remote migrations')
    }

    const appliedNames = remote.data.appliedMigrations
    const targetName = name || appliedNames[appliedNames.length - 1]
    if (!targetName) {
        throw new Error('No applied migrations to roll back')
    }

    const migration = localFiles.find(file => file.name === targetName)
    if (!migration) {
        throw new Error(`Local migration file for "${targetName}" was not found`)
    }

    const result = await client.admin.migrations.rollback(migration)
    if (result.error) {
        throw new Error(`Failed to roll back ${migration.name}: ${result.error.message}`)
    }

    console.log(`Rolled back ${migration.name}`)
}

async function handleDbPush(flags: Record<string, string>): Promise<void> {
    const loaded = loadConfig(flags.config)
    await runPendingMigrations(loaded)
}

async function handleDbPull(flags: Record<string, string>): Promise<void> {
    const loaded = loadConfig(flags.config)
    const schema = await fetchSchemaExport(loaded.config)
    const outputPath = resolveFromConfig(loaded.configPath, flags.out || loaded.config.schemaOutput)
    mkdirSync(dirname(outputPath), { recursive: true })
    await writeFile(outputPath, `${JSON.stringify(schema, null, 2)}\n`)
    console.log(`Wrote schema export to ${outputPath}`)
}

async function handleDbReset(flags: Record<string, string>): Promise<void> {
    const loaded = loadConfig(flags.config)
    const client = createAdminClient(loaded.config.apiUrl, loaded.config.serviceRoleKey)
    const [localFiles, remote] = await Promise.all([
        readMigrationFiles(loaded),
        client.admin.migrations.list(),
    ])

    if (remote.error || !remote.data) {
        throw new Error(remote.error?.message || 'Failed to list remote migrations')
    }

    const byName = new Map(localFiles.map(file => [file.name, file]))
    const rollbackQueue = [...remote.data.appliedMigrations]
        .map(name => byName.get(name) ?? null)
        .filter((file): file is Awaited<ReturnType<typeof readMigrationFiles>>[number] => file !== null)
        .reverse()

    for (const migration of rollbackQueue) {
        const result = await client.admin.migrations.rollback(migration)
        if (result.error) {
            throw new Error(`Failed to roll back ${migration.name}: ${result.error.message}`)
        }
        console.log(`Rolled back ${migration.name}`)
    }

    if (flags.reapply !== 'false') {
        await runPendingMigrations(loaded)
    }

    if (flags.seed === 'true') {
        await runSeed(loaded)
    }
}

async function handleSeed(flags: Record<string, string>): Promise<void> {
    const loaded = loadConfig(flags.config)
    await runSeed(loaded, flags.file)
}

function loadConfig(customPath?: string): LoadedConfig {
    const configPath = resolve(customPath || 'openbase.config.json')
    if (!existsSync(configPath)) {
        throw new Error(`OpenBase config not found at ${configPath}. Run "openbase init" first.`)
    }

    const parsed = JSON.parse(readFileSync(configPath, 'utf8')) as Partial<OpenBaseConfig>
    return {
        config: {
            ...DEFAULT_CONFIG,
            ...parsed,
        },
        configPath,
    }
}

async function fetchSchemaExport(config: OpenBaseConfig): Promise<SchemaExport> {
    const client = createAdminClient(config.apiUrl, config.serviceRoleKey)
    const schema = await client.admin.schema.export()
    if (schema.error || !schema.data) {
        throw new Error(schema.error?.message || 'Failed to export schema')
    }
    return schema.data
}

async function runPendingMigrations(loaded: LoadedConfig): Promise<void> {
    const client = createAdminClient(loaded.config.apiUrl, loaded.config.serviceRoleKey)
    const [localFiles, remote] = await Promise.all([
        readMigrationFiles(loaded),
        client.admin.migrations.list(),
    ])

    if (remote.error || !remote.data) {
        throw new Error(remote.error?.message || 'Failed to list remote migrations')
    }

    const pending = localFiles.filter(file => !remote.data!.appliedMigrations.includes(file.name))
    if (pending.length === 0) {
        console.log('No pending migrations')
        return
    }

    for (const migration of pending) {
        const result = await client.admin.migrations.apply(migration)
        if (result.error) {
            throw new Error(`Failed to apply ${migration.name}: ${result.error.message}`)
        }
        console.log(`Applied ${migration.name}`)
    }
}

async function runSeed(loaded: LoadedConfig, customFile?: string): Promise<void> {
    const seedPath = resolveFromConfig(loaded.configPath, customFile || loaded.config.seedFile)
    if (!existsSync(seedPath)) {
        throw new Error(`Seed file not found at ${seedPath}`)
    }

    const raw = readFileSync(seedPath, 'utf8')
    const parsed = JSON.parse(raw) as SeedFile
    const tables = normalizeSeedTables(parsed)
    const client = createAdminClient(loaded.config.apiUrl, loaded.config.serviceRoleKey)

    for (const [tableName, rows] of Object.entries(tables)) {
        if (!Array.isArray(rows) || rows.length === 0) {
            continue
        }

        const result = await client.from(tableName).insert(rows)
        if (result.error) {
            throw new Error(`Failed to seed ${tableName}: ${result.error.message}`)
        }

        console.log(`Seeded ${rows.length} row(s) into ${tableName}`)
    }
}

async function readMigrationFiles(loaded: LoadedConfig): Promise<Array<MigrationFile & { checksum: string; source: 'cli' }>> {
    const resolvedDir = resolveFromConfig(loaded.configPath, loaded.config.migrationsDir)
    if (!existsSync(resolvedDir)) {
        return []
    }

    const entries = await readdir(resolvedDir)
    const files = await Promise.all(
        entries
            .filter(entry => entry.endsWith('.json'))
            .sort()
            .map(async entry => {
                const filePath = resolve(resolvedDir, entry)
                if (!(await stat(filePath)).isFile()) {
                    return null
                }

                const raw = readFileSync(filePath, 'utf8')
                const parsed = migrationDefinitionSchema.parse(JSON.parse(raw))
                return {
                    ...parsed,
                    checksum: createHash('sha256').update(raw).digest('hex'),
                    source: 'cli' as const,
                }
            })
    )

    return files.filter((file): file is MigrationFile & { checksum: string; source: 'cli' } => file !== null)
}

function normalizeSeedTables(seed: SeedFile): Record<string, Record<string, unknown>[]> {
    if (seed.tables && typeof seed.tables === 'object') {
        return seed.tables
    }

    return Object.fromEntries(
        Object.entries(seed).filter(([, value]) => Array.isArray(value))
    ) as Record<string, Record<string, unknown>[]>
}

function writeJson(pathname: string, data: unknown): void {
    writeFileSync(pathname, `${JSON.stringify(data, null, 2)}\n`)
}

function resolveFromConfig(configPath: string, target: string): string {
    return resolve(dirname(configPath), target)
}

function getRuntimeDir(configPath: string): string {
    return resolve(dirname(configPath), 'openbase', '.runtime')
}

function getRuntimeStatePath(configPath: string): string {
    return join(getRuntimeDir(configPath), 'process.json')
}

function readRuntimeState(configPath: string): LocalRuntimeState | null {
    const statePath = getRuntimeStatePath(configPath)
    if (!existsSync(statePath)) {
        return null
    }

    try {
        const parsed = JSON.parse(readFileSync(statePath, 'utf8')) as Partial<LocalRuntimeState>
        if (parsed.mode === 'compose') {
            return {
                mode: 'compose',
                startedAt: parsed.startedAt || new Date(0).toISOString(),
                workdir: parsed.workdir || process.cwd(),
                envFilePath: parsed.envFilePath,
                projectName: parsed.projectName,
            }
        }

        if (typeof parsed.pid === 'number') {
            return {
                mode: 'process',
                startedAt: parsed.startedAt || new Date(0).toISOString(),
                workdir: parsed.workdir || process.cwd(),
                pid: parsed.pid,
                pids: Array.isArray(parsed.pids) ? parsed.pids.filter((pid): pid is number => typeof pid === 'number') : undefined,
                stdoutPath: parsed.stdoutPath,
                stderrPath: parsed.stderrPath,
                envFilePath: parsed.envFilePath,
            }
        }

        return null
    } catch {
        return null
    }
}

function writeRuntimeState(configPath: string, state: LocalRuntimeState): void {
    mkdirSync(getRuntimeDir(configPath), { recursive: true })
    writeJson(getRuntimeStatePath(configPath), state)
}

function deleteRuntimeState(configPath: string): void {
    const statePath = getRuntimeStatePath(configPath)
    if (existsSync(statePath)) {
        rmSync(statePath, { force: true })
    }
}

function findWorkspaceRoot(startDir: string): string | null {
    let current = resolve(startDir)
    while (true) {
        if (existsSync(join(current, 'pnpm-workspace.yaml'))) {
            return current
        }

        const parent = dirname(current)
        if (parent === current) {
            return null
        }
        current = parent
    }
}

function ensureComposeEnvFile(loaded: LoadedConfig): string {
    const runtimeDir = getRuntimeDir(loaded.configPath)
    mkdirSync(runtimeDir, { recursive: true })
    const envFilePath = join(runtimeDir, 'openbase.compose.env')
    const env = {
        OPENBASE_RUNTIME_ENV_FILE: envFilePath.replace(/\\/g, '/'),
        PORT: '3001',
        NODE_ENV: 'production',
        JWT_SECRET: 'openbase-local-jwt-secret-123456',
        STORAGE_SECRET: 'openbase-local-storage-secret-123456',
        REDIS_URL: 'redis://redis:6379',
        SQLITE_BASE_PATH: './data/indexes',
        BACKUP_ROOT_PATH: './data/backups',
        BACKUP_INTERVAL_MINUTES: '720',
        BACKUP_RETENTION_COUNT: '10',
        DASHBOARD_URL: 'http://localhost:3000',
        API_PUBLIC_URL: loaded.config.apiUrl,
        NEXT_PUBLIC_API_URL: loaded.config.apiUrl,
        MASTER_ENCRYPTION_KEY: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
        MOCK_TELEGRAM: 'true',
        SKIP_WARMUP: 'false',
        TELEGRAM_API_ID: '',
        TELEGRAM_API_HASH: '',
        RESEND_API_KEY: '',
        RESEND_FROM_EMAIL: '',
        GOOGLE_CLIENT_ID: '',
        GOOGLE_CLIENT_SECRET: '',
        GITHUB_CLIENT_ID: '',
        GITHUB_CLIENT_SECRET: '',
    }

    const contents = Object.entries(env)
        .map(([key, value]) => `${key}=${value}`)
        .join('\n')
    writeFileSync(envFilePath, `${contents}\n`)
    return envFilePath
}

function ensureProcessEnvFile(loaded: LoadedConfig): string {
    const runtimeDir = getRuntimeDir(loaded.configPath)
    mkdirSync(runtimeDir, { recursive: true })
    const envFilePath = join(runtimeDir, 'openbase.process.env')
    const env = buildApiProcessEnvOverrides(loaded.config, envFilePath)
    const contents = Object.entries(env)
        .map(([key, value]) => `${key}=${value}`)
        .join('\n')
    writeFileSync(envFilePath, `${contents}\n`)
    return envFilePath
}

function getComposeProjectName(configPath: string): string {
    return `openbase-${createHash('sha1').update(resolve(configPath)).digest('hex').slice(0, 10)}`
}

function dockerComposeAvailable(): boolean {
    return spawnSync('docker', ['compose', 'version'], { stdio: 'ignore' }).status === 0
}

function runComposeCommand(
    workdir: string,
    projectName: string,
    envFilePath: string,
    args: string[]
): void {
    const result = spawnSync(
        'docker',
        ['compose', '--project-name', projectName, '--env-file', envFilePath, ...args],
        {
            cwd: workdir,
            stdio: 'inherit',
        }
    )

    if (result.status !== 0) {
        throw new Error(`Docker Compose command failed: docker compose ${args.join(' ')}`)
    }
}

interface ComposeServiceStatus {
    service: string
    state: string
    health: string
}

function readComposeServices(
    workdir: string,
    projectName: string,
    envFilePath: string
): ComposeServiceStatus[] {
    const result = spawnSync(
        'docker',
        ['compose', '--project-name', projectName, '--env-file', envFilePath, 'ps', '--all', '--format', 'json'],
        {
            cwd: workdir,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
        }
    )

    if (result.status !== 0) {
        return []
    }

    const raw = result.stdout.trim()
    if (!raw) {
        return []
    }

    const items = raw.startsWith('[')
        ? JSON.parse(raw) as Array<Record<string, unknown>>
        : raw
            .split(/\r?\n/)
            .filter(Boolean)
            .map(line => JSON.parse(line) as Record<string, unknown>)

    return items.map(item => ({
        service: String(item.Service ?? item.Name ?? 'unknown'),
        state: String(item.State ?? item.Status ?? 'unknown'),
        health: String(item.Health ?? ''),
    }))
}

function buildApiProcessEnv(config: OpenBaseConfig, dotenvPath: string): NodeJS.ProcessEnv {
    return {
        ...process.env,
        ...buildApiProcessEnvOverrides(config, dotenvPath),
    }
}

function buildApiProcessEnvOverrides(config: OpenBaseConfig, dotenvPath: string): Record<string, string> {
    return {
        PORT: '3001',
        NODE_ENV: 'production',
        JWT_SECRET: 'openbase-local-jwt-secret-123456',
        STORAGE_SECRET: 'openbase-local-storage-secret-123456',
        REDIS_URL: 'memory://openbase-local',
        DASHBOARD_URL: 'http://localhost:3000',
        API_PUBLIC_URL: config.apiUrl,
        NEXT_PUBLIC_API_URL: config.apiUrl,
        MASTER_ENCRYPTION_KEY: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
        MOCK_TELEGRAM: 'true',
        SKIP_WARMUP: 'false',
        RESEND_API_KEY: '',
        RESEND_FROM_EMAIL: '',
        GOOGLE_CLIENT_ID: '',
        GOOGLE_CLIENT_SECRET: '',
        GITHUB_CLIENT_ID: '',
        GITHUB_CLIENT_SECRET: '',
        DOTENV_CONFIG_PATH: dotenvPath,
        DOTENV_CONFIG_OVERRIDE: 'true',
    }
}

function buildDashboardProcessEnv(config: OpenBaseConfig): NodeJS.ProcessEnv {
    return {
        ...process.env,
        NODE_ENV: 'production',
        NEXT_PUBLIC_API_URL: config.apiUrl,
        PORT: '3000',
    }
}

function writeLogFile(pathname: string): number {
    return openSync(pathname, 'a')
}

function resolveDashboardCli(workdir: string): string {
    const candidates = [
        join(workdir, 'apps/dashboard/node_modules/next/dist/bin/next'),
        join(workdir, 'node_modules/next/dist/bin/next'),
    ]

    for (const candidate of candidates) {
        if (existsSync(candidate)) {
            return candidate
        }
    }

    throw new Error('Unable to locate the Next.js CLI for the dashboard package.')
}

async function waitForLocalStack(pids: number[], timeoutMs = 120_000): Promise<void> {
    const startedAt = Date.now()
    while (Date.now() - startedAt < timeoutMs) {
        const [apiReady, dashboardReady] = await Promise.all([
            checkUrl('http://127.0.0.1:3001/health'),
            checkUrl('http://127.0.0.1:3000/login'),
        ])

        if (apiReady && dashboardReady) {
            return
        }

        if (pids.length > 0 && pids.every(pid => getProcessStatus(pid) === 'stopped')) {
            throw new Error('The local OpenBase processes exited before the stack became ready.')
        }

        await new Promise(resolvePromise => setTimeout(resolvePromise, 1_000))
    }

    throw new Error('Timed out waiting for the local OpenBase stack to become ready.')
}

async function checkUrl(url: string): Promise<boolean> {
    try {
        const response = await fetch(url)
        return response.ok
    } catch {
        return false
    }
}

function getProcessStatus(pid: number): 'running' | 'stopped' {
    try {
        process.kill(pid, 0)
        return 'running'
    } catch {
        return 'stopped'
    }
}

function stopProcess(pid: number): void {
    if (process.platform === 'win32') {
        spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
        return
    }

    try {
        process.kill(-pid, 'SIGTERM')
    } catch {
        process.kill(pid, 'SIGTERM')
    }
}

function hasConfiguredServiceRoleKey(value: string): boolean {
    return value.length > 0 && value !== DEFAULT_CONFIG.serviceRoleKey
}

function extractProjectIdFromToken(token: string): string {
    try {
        const parts = token.split('.')
        if (parts.length !== 3) {
            return ''
        }

        const payloadPart = parts[1]
            .replace(/-/g, '+')
            .replace(/_/g, '/')
            .padEnd(Math.ceil(parts[1].length / 4) * 4, '=')

        const payload = JSON.parse(Buffer.from(payloadPart, 'base64').toString('utf8')) as { projectId?: string }
        return payload.projectId || ''
    } catch {
        return ''
    }
}

function printUsage(): void {
    console.log([
        'OpenBase CLI',
        '',
        'Commands:',
        '  openbase init [--api-url <url>] [--project-id <id>] [--service-role-key <key>]',
        '  openbase status',
        '  openbase start [--workdir <path>]',
        '  openbase stop',
        '  openbase gen types [--out <path>]',
        '  openbase migration new <name>',
        '  openbase migration run',
        '  openbase migration rollback [name]',
        '  openbase db push',
        '  openbase db pull [--out <path>]',
        '  openbase db reset [--reapply true|false] [--seed true|false]',
        '  openbase seed [--file <path>]',
    ].join('\n'))
}

void main().catch(error => {
    console.error((error as Error).message)
    process.exit(1)
})
