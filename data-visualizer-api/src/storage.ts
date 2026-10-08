import { metadataDb } from './config.js';
import { connections, joinSchema, queryPlanSchema, visualizations } from './models.js';

export async function initializeStorage(): Promise<void> {
    if (!metadataDb) return;
    await metadataDb.query(`CREATE TABLE IF NOT EXISTS saved_connections (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        host TEXT NOT NULL,
        port INTEGER NOT NULL,
        database_name TEXT NOT NULL,
        username TEXT NOT NULL,
        encrypted_password TEXT NOT NULL,
        tls BOOLEAN NOT NULL,
        created_at TIMESTAMPTZ NOT NULL
    )`);
    await metadataDb.query(`CREATE TABLE IF NOT EXISTS saved_visualizations (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        connection_id TEXT NOT NULL,
        source TEXT NOT NULL,
        join_definition JSONB,
        request TEXT NOT NULL,
        type TEXT NOT NULL,
        schema_data JSONB NOT NULL,
        query_plan JSONB NOT NULL,
        filter_controls JSONB NOT NULL,
        select_mode TEXT NOT NULL DEFAULT 'single',
        default_selects JSONB NOT NULL DEFAULT '[]'::jsonb,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL
    )`);
    await metadataDb.query('ALTER TABLE saved_visualizations ADD COLUMN IF NOT EXISTS chart_definition JSONB');
    await metadataDb.query('ALTER TABLE saved_visualizations ADD COLUMN IF NOT EXISTS join_definition JSONB');
    await metadataDb.query("ALTER TABLE saved_visualizations ADD COLUMN IF NOT EXISTS select_mode TEXT NOT NULL DEFAULT 'single'");
    await metadataDb.query("ALTER TABLE saved_visualizations ADD COLUMN IF NOT EXISTS default_selects JSONB NOT NULL DEFAULT '[]'::jsonb");
    const result = await metadataDb.query('SELECT id, name, type, host, port, database_name, username, encrypted_password, tls, created_at FROM saved_connections ORDER BY created_at DESC');
    connections.push(...result.rows.map((row) => ({
        id: row.id,
        name: row.name,
        type: row.type,
        host: row.host,
        port: row.port,
        database: row.database_name,
        username: row.username,
        password: row.encrypted_password,
        tls: row.tls,
        createdAt: new Date(row.created_at).toISOString()
    })));
    const visualizationResult = await metadataDb.query('SELECT id, title, connection_id, source, join_definition, request, type, schema_data, query_plan, filter_controls, select_mode, default_selects, chart_definition, created_at, updated_at FROM saved_visualizations ORDER BY created_at DESC');
    visualizations.push(...visualizationResult.rows.map((row) => ({
        id: row.id,
        title: row.title,
        connectionId: row.connection_id,
        source: row.source,
        ...(row.join_definition ? { join: joinSchema.parse(row.join_definition) } : {}),
        request: row.request,
        type: row.type,
        schema: row.schema_data,
        queryPlan: queryPlanSchema.parse(row.query_plan),
        filterControls: row.filter_controls,
        selectMode: row.select_mode === 'multiple' ? 'multiple' as const : 'single' as const,
        defaultSelects: Array.isArray(row.default_selects) ? row.default_selects : [],
        chart: row.chart_definition ?? undefined,
        createdAt: new Date(row.created_at).toISOString(),
        updatedAt: new Date(row.updated_at).toISOString()
    })));
}
