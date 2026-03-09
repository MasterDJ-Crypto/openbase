#!/usr/bin/env node

import { createHash } from 'crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { readdir, stat, writeFile } from 'fs/promises'
import { dirname, resolve } from 'path'
import type { MigrationDefinition } from '@openbase/core'
import { migrationDefinitionSchema } from '@openbase/core'
import { createAdminClient, generateTypescriptSchemaClient } from 'openbase-js'

interface OpenBaseConfig {
    apiUrl: string
    projectId: string
    serviceRoleKey: string
    migrationsDir: string
    typesOutput: string
}

type MigrationFile = MigrationDefinition

const DEFAULT_CONFIG: OpenBaseConfig = {
    apiUrl: 'http://localhost:3001',
    projectId: 'your-project-id',
    serviceRoleKey: 'your-service-role-key',
    migrationsDir: 'openbase/migrations',
    typesOutput: 'openbase/generated.ts',
}

async function main(): Promise<void> {
    const [, , command, subcommand, ...rest] = process.argv

    switch (`${command ?? ''} ${subcommand ?? ''}`.trim()) {
        case 'init':
            await handleInit(parseFlags([subcommand, ...rest]))
            return
        case 'status':
            await handleStatus(parseFlags([subcommand, ...rest]))
            return
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
            await handleMigrationRollback(rest[0]?.startsWith('--') ? undefined : rest[0], parseFlags(rest[0]?.startsWith('--') ? rest : rest.slice(1)))
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
    const cwd = dirname(configPath)
    mkdirSync(cwd, { recursive: true })
    if (existsSync(configPath) && flags.force !== 'true') {
        throw new Error(`Config already exists at ${configPath}. Pass --force true to overwrite.`)
    }

    const config: OpenBaseConfig = {
        apiUrl: flags['api-url'] || DEFAULT_CONFIG.apiUrl,
        projectId: flags['project-id'] || DEFAULT_CONFIG.projectId,
        serviceRoleKey: flags['service-role-key'] || DEFAULT_CONFIG.serviceRoleKey,
        migrationsDir: flags['migrations-dir'] || DEFAULT_CONFIG.migrationsDir,
        typesOutput: flags['types-output'] || DEFAULT_CONFIG.typesOutput,
    }

    writeJson(configPath, config)
    mkdirSync(resolve(cwd, config.migrationsDir), { recursive: true })
    console.log(`Initialized OpenBase config at ${configPath}`)
}

async function handleStatus(flags: Record<string, string>): Promise<void> {
    const config = loadConfig(flags.config)
    const client = createAdminClient(config.apiUrl, config.serviceRoleKey)
    const [schema, migrations] = await Promise.all([
        client.admin.schema.export(),
        client.admin.migrations.list(),
    ])

    if (schema.error) {
        throw new Error(schema.error.message)
    }
    if (migrations.error) {
        throw new Error(migrations.error.message)
    }

    console.log(`Project: ${schema.data?.projectName} (${schema.data?.projectId})`)
    console.log(`Tables: ${Object.keys(schema.data?.tables || {}).length}`)
    console.log(`Applied migrations: ${migrations.data?.appliedMigrations.length || 0}`)
}

async function handleGenerateTypes(flags: Record<string, string>): Promise<void> {
    const config = loadConfig(flags.config)
    const outputPath = resolve(flags.out || config.typesOutput)
    const client = createAdminClient(config.apiUrl, config.serviceRoleKey)
    const schema = await client.admin.schema.export()
    if (schema.error || !schema.data) {
        throw new Error(schema.error?.message || 'Failed to export schema')
    }

    mkdirSync(dirname(outputPath), { recursive: true })
    await writeFile(outputPath, generateTypescriptSchemaClient(schema.data))
    console.log(`Wrote generated client types to ${outputPath}`)
}

async function handleMigrationNew(name: string | undefined, flags: Record<string, string>): Promise<void> {
    if (!name) {
        throw new Error('Migration name is required')
    }

    const config = loadConfig(flags.config)
    const migrationsDir = resolve(config.migrationsDir)
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
    const config = loadConfig(flags.config)
    const client = createAdminClient(config.apiUrl, config.serviceRoleKey)
    const [localFiles, remote] = await Promise.all([
        readMigrationFiles(config.migrationsDir),
        client.admin.migrations.list(),
    ])

    if (remote.error || !remote.data) {
        throw new Error(remote.error?.message || 'Failed to list remote migrations')
    }

    const pending = localFiles.filter((file: MigrationFile & { checksum: string; source: 'cli' }) => !remote.data!.appliedMigrations.includes(file.name))
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

async function handleMigrationRollback(name: string | undefined, flags: Record<string, string>): Promise<void> {
    const config = loadConfig(flags.config)
    const client = createAdminClient(config.apiUrl, config.serviceRoleKey)
    const [localFiles, remote] = await Promise.all([
        readMigrationFiles(config.migrationsDir),
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

    const migration = localFiles.find((file: MigrationFile & { checksum: string; source: 'cli' }) => file.name === targetName)
    if (!migration) {
        throw new Error(`Local migration file for "${targetName}" was not found`)
    }

    const result = await client.admin.migrations.rollback(migration)
    if (result.error) {
        throw new Error(`Failed to roll back ${migration.name}: ${result.error.message}`)
    }

    console.log(`Rolled back ${migration.name}`)
}

function loadConfig(customPath?: string): OpenBaseConfig {
    const configPath = resolve(customPath || 'openbase.config.json')
    if (!existsSync(configPath)) {
        throw new Error(`OpenBase config not found at ${configPath}. Run "openbase init" first.`)
    }

    const parsed = JSON.parse(readFileSync(configPath, 'utf8')) as Partial<OpenBaseConfig>
    return {
        ...DEFAULT_CONFIG,
        ...parsed,
    }
}

async function readMigrationFiles(migrationsDir: string): Promise<Array<MigrationFile & { checksum: string; source: 'cli' }>> {
    const resolvedDir = resolve(migrationsDir)
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

function writeJson(pathname: string, data: unknown): void {
    writeFileSync(pathname, `${JSON.stringify(data, null, 2)}\n`)
}

function printUsage(): void {
    console.log([
        'OpenBase CLI',
        '',
        'Commands:',
        '  openbase init [--api-url <url>] [--project-id <id>] [--service-role-key <key>]',
        '  openbase status',
        '  openbase gen types [--out <path>]',
        '  openbase migration new <name>',
        '  openbase migration run',
        '  openbase migration rollback [name]',
    ].join('\n'))
}

void main().catch(error => {
    console.error((error as Error).message)
    process.exit(1)
})
