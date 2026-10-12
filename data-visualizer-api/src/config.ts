import pg from 'pg';

export const port = Number(process.env.PORT ?? 3000);

export const origin = process.env.WEB_ORIGIN ?? 'http://localhost:4200';

export const aiProvider = (process.env.AI_PROVIDER ?? 'deepseek').toLowerCase();

export function isAiConfigured(): boolean {
    if (!process.env.AI_MODEL?.trim()) return false;
    if (aiProvider === 'deepseek') return Boolean(process.env.DEEPSEEK_API_KEY?.trim());
    if (aiProvider === 'openai') return Boolean(process.env.OPENAI_API_KEY?.trim());
    if (aiProvider !== 'custom' || !process.env.AI_CHAT_COMPLETIONS_URL?.trim()) return false;
    try {
        const endpoint = new URL(process.env.AI_CHAT_COMPLETIONS_URL);
        return endpoint.protocol === 'http:' || endpoint.protocol === 'https:';
    } catch {
        return false;
    }
}

export const encryptionKey = Buffer.from(process.env.CREDENTIAL_ENCRYPTION_KEY ?? 'replace-with-a-32-byte-secret-key-123456').subarray(0, 32);

export const metadataDb = process.env.DATABASE_URL ? new pg.Pool({ connectionString: process.env.DATABASE_URL }) : null;
