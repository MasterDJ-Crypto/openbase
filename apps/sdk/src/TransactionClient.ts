import { transactionResultSchema } from '@openbase/core'
import type { TransactionOperation, TransactionResult } from './types.js'
import { parseApiEnvelope } from './http.js'

export class TransactionClient {
    constructor(
        private readonly projectUrl: string,
        private readonly projectId: string,
        private readonly apiKey: string,
        private readonly getAccessToken: () => string | null
    ) { }

    async execute(
        operations: TransactionOperation[]
    ): Promise<{ data: TransactionResult | null; error: { message: string; code?: string } | null }> {
        try {
            const token = this.getAccessToken() || this.apiKey
            const fetchFn = typeof globalThis.fetch !== 'undefined' ? globalThis.fetch : (await import('cross-fetch')).default
            const response = await fetchFn(
                `${this.projectUrl}/api/v1/${this.projectId}/transactions`,
                {
                    method: 'POST',
                    headers: {
                        Authorization: `Bearer ${token}`,
                        'Content-Type': 'application/json',
                        apikey: this.apiKey,
                    },
                    body: JSON.stringify({ operations }),
                }
            )

            const result = await parseApiEnvelope(response, transactionResultSchema)
            return {
                data: (result.data as TransactionResult | null) || null,
                error: result.error ? { message: result.error.message, code: result.error.code } : null,
            }
        } catch (error) {
            return {
                data: null,
                error: { message: (error as Error).message, code: 'NETWORK_ERROR' },
            }
        }
    }
}
