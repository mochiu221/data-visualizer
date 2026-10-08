import { MongoClient } from 'mongodb';
import mysql from 'mysql2/promise';
import pg from 'pg';
import sql from 'mssql';
import { decrypt } from './security.js';
import type { ChartDefinition, Connection, QueryPlan, SchemaColumn, SelectField, TableSource } from './models.js';

function mongoConnectionUri(connection: Connection, password: string): string {
    const credentials = connection.username && password ? `${encodeURIComponent(connection.username)}:${encodeURIComponent(password)}@` : '';
    return `mongodb://${credentials}${connection.host}:${connection.port}`;
}

export function quoteIdentifier(identifier: string): string {
    identifier = identifier.replace(/^\[([A-Za-z_][A-Za-z0-9_$]*)\](?:\.\[([A-Za-z_][A-Za-z0-9_$]*)\])?$/, (_, first: string, second?: string) => second ? `${first}.${second}` : first);
    if (!/^[A-Za-z_][A-Za-z0-9_$]*(\.[A-Za-z_][A-Za-z0-9_$]*)?$/.test(identifier)) throw new Error('Table or collection name contains invalid characters.');
    return identifier.split('.').map((part) => `[${part}]`).join('.');
}

export function normalizePreview(value: unknown): Record<string, string | number> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return { value: String(value ?? '') };
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, item instanceof Date ? item.toISOString() : typeof item === 'number' || typeof item === 'string' ? item : JSON.stringify(item)]));
}

export function schemaSource(source: string): { schema?: string; table: string } {
    source = source.replace(/^\[([A-Za-z_][A-Za-z0-9_$]*)\](?:\.\[([A-Za-z_][A-Za-z0-9_$]*)\])?$/, (_, first: string, second?: string) => second ? `${first}.${second}` : first);
    const parts = source.split('.');
    const table = parts.pop();
    if (!table || parts.length > 1 || !/^[A-Za-z_][A-Za-z0-9_$]*$/.test(table) || parts.some((part) => !/^[A-Za-z_][A-Za-z0-9_$]*$/.test(part))) throw new Error('Table or collection name contains invalid characters.');
    return { schema: parts[0], table };
}

export async function listTables(connection: Connection): Promise<TableSource[]> {
    const password = connection.password ? decrypt(connection.password) : '';
    if (connection.type === 'mongodb') {
        const client = new MongoClient(mongoConnectionUri(connection, password), { tls: connection.tls, serverSelectionTimeoutMS: 10_000 });
        try {
            await client.connect();
            const collections = await client.db(connection.database).listCollections({}, { nameOnly: true }).toArray();
            return collections.map((collection) => ({ name: collection.name, type: 'collection' as const }));
        } finally { await client.close(); }
    }
    if (connection.type === 'mssql') {
        const pool = await sql.connect({ user: connection.username, password, server: connection.host, port: connection.port, database: connection.database, options: { encrypt: connection.tls, trustServerCertificate: !connection.tls }, requestTimeout: 10_000 });
        try {
            const result = await pool.request().query("SELECT TABLE_SCHEMA AS schemaName, TABLE_NAME AS tableName, TABLE_TYPE AS tableType FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_TYPE IN ('BASE TABLE', 'VIEW') ORDER BY TABLE_SCHEMA, TABLE_NAME");
            return result.recordset.map((row) => ({ name: `${row.schemaName}.${row.tableName}`, type: row.tableType === 'VIEW' ? 'view' as const : 'table' as const }));
        } finally { await pool.close(); }
    }
    if (connection.type === 'postgresql') {
        const client = new pg.Client({ host: connection.host, port: connection.port, database: connection.database, user: connection.username, password, ssl: connection.tls ? { rejectUnauthorized: false } : false, statement_timeout: 10_000 });
        try {
            await client.connect();
            const result = await client.query("SELECT table_schema AS \"schemaName\", table_name AS \"tableName\", table_type AS \"tableType\" FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog', 'information_schema') AND table_type IN ('BASE TABLE', 'VIEW') ORDER BY table_schema, table_name");
            return result.rows.map((row) => ({ name: `${row.schemaName}.${row.tableName}`, type: row.tableType === 'VIEW' ? 'view' as const : 'table' as const }));
        } finally { await client.end(); }
    }
    const connectionHandle = await mysql.createConnection({ host: connection.host, port: connection.port, database: connection.database, user: connection.username, password, ssl: connection.tls ? {} : undefined, connectTimeout: 10_000 });
    try {
        const [rows] = await connectionHandle.query("SELECT TABLE_NAME AS name, TABLE_TYPE AS tableType FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE IN ('BASE TABLE', 'VIEW') ORDER BY TABLE_NAME");
        return (rows as Array<{ name: string; tableType: string }>).map((row) => ({ name: row.name, type: row.tableType === 'VIEW' ? 'view' as const : 'table' as const }));
    } finally { await connectionHandle.end(); }
}

export async function discoverSchema(connection: Connection, source: string): Promise<SchemaColumn[]> {
    const target = connection.type === 'mongodb'
        ? (/^[A-Za-z0-9_.-]+$/.test(source) ? { table: source } : (() => { throw new Error('Collection name contains invalid characters.'); })())
        : schemaSource(source);
    const password = connection.password ? decrypt(connection.password) : '';
    if (connection.type === 'mongodb') {
        const client = new MongoClient(mongoConnectionUri(connection, password), { tls: connection.tls, serverSelectionTimeoutMS: 10_000 });
        try {
            await client.connect();
            const sample = await client.db(connection.database).collection(target.table).findOne();
            if (!sample) throw new Error('The collection is empty or does not exist.');
            return Object.entries(sample).map(([name, value]) => ({ name, type: Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value }));
        } finally { await client.close(); }
    }
    if (connection.type === 'mssql') {
        const pool = await sql.connect({ user: connection.username, password, server: connection.host, port: connection.port, database: connection.database, options: { encrypt: connection.tls, trustServerCertificate: !connection.tls }, requestTimeout: 10_000 });
        try {
            const requestHandle = pool.request().input('tableName', target.table);
            if (target.schema) requestHandle.input('schemaName', target.schema);
            const result = await requestHandle.query(`SELECT COLUMN_NAME AS name, DATA_TYPE AS type FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = @tableName${target.schema ? ' AND TABLE_SCHEMA = @schemaName' : ''} ORDER BY ORDINAL_POSITION`);
            if (!result.recordset.length) throw new Error('The table or view does not exist.');
            return result.recordset;
        } finally { await pool.close(); }
    }
    if (connection.type === 'postgresql') {
        const client = new pg.Client({ host: connection.host, port: connection.port, database: connection.database, user: connection.username, password, ssl: connection.tls ? { rejectUnauthorized: false } : false, statement_timeout: 10_000 });
        try {
            await client.connect();
            const result = await client.query(`SELECT column_name AS name, data_type AS type FROM information_schema.columns WHERE table_name = $1 AND table_schema = COALESCE($2, current_schema()) ORDER BY ordinal_position`, [target.table, target.schema ?? null]);
            if (!result.rows.length) throw new Error('The table or view does not exist.');
            return result.rows;
        } finally { await client.end(); }
    }
    const connectionHandle = await mysql.createConnection({ host: connection.host, port: connection.port, database: connection.database, user: connection.username, password, ssl: connection.tls ? {} : undefined, connectTimeout: 10_000 });
    try {
        const [rows] = await connectionHandle.query('SELECT COLUMN_NAME AS name, DATA_TYPE AS type FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION', [target.table]);
        const columns = rows as SchemaColumn[];
        if (!columns.length) throw new Error('The table or view does not exist.');
        return columns;
    } finally { await connectionHandle.end(); }
}

export async function verifyConnection(connection: Connection): Promise<void> {
    const password = connection.password ? decrypt(connection.password) : '';
    if (connection.type === 'mongodb') {
        const client = new MongoClient(mongoConnectionUri(connection, password), { tls: connection.tls, serverSelectionTimeoutMS: 10_000 });
        try { await client.connect(); await client.db(connection.database).command({ ping: 1 }); } finally { await client.close(); }
        return;
    }
    if (connection.type === 'mssql') {
        const pool = await sql.connect({ user: connection.username, password, server: connection.host, port: connection.port, database: connection.database, options: { encrypt: connection.tls, trustServerCertificate: !connection.tls }, requestTimeout: 10_000 });
        try { await pool.request().query('SELECT 1'); } finally { await pool.close(); }
        return;
    }
    if (connection.type === 'postgresql') {
        const client = new pg.Client({ host: connection.host, port: connection.port, database: connection.database, user: connection.username, password, ssl: connection.tls ? { rejectUnauthorized: false } : false, connectionTimeoutMillis: 10_000 });
        try { await client.connect(); await client.query('SELECT 1'); } finally { await client.end(); }
        return;
    }
    const connectionHandle = await mysql.createConnection({ host: connection.host, port: connection.port, database: connection.database, user: connection.username, password, ssl: connection.tls ? {} : undefined, connectTimeout: 10_000 });
    try { await connectionHandle.query('SELECT 1'); } finally { await connectionHandle.end(); }
}

export async function listDistinctValues(connection: Connection, source: string, field: string): Promise<Array<string | number | boolean>> {
    if (!/^[A-Za-z_][A-Za-z0-9_$]*$/.test(field)) throw new Error('Category field contains invalid characters.');
    if (connection.type === 'mongodb') {
        if (!/^[A-Za-z0-9_.-]+$/.test(source)) throw new Error('Collection name contains invalid characters.');
        const password = connection.password ? decrypt(connection.password) : '';
        const client = new MongoClient(mongoConnectionUri(connection, password), { tls: connection.tls, serverSelectionTimeoutMS: 10_000 });
        try {
            await client.connect();
            const values = await client.db(connection.database).collection(source).distinct(field);
            return values.filter((value): value is string | number | boolean => ['string', 'number', 'boolean'].includes(typeof value)).slice(0, 100);
        } finally { await client.close(); }
    }
    const password = connection.password ? decrypt(connection.password) : '';
    const fieldSql = quoteField(field, connection.type);
    const tableSql = connection.type === 'mssql' ? quoteIdentifier(source) : quoteField(source, connection.type);
    if (connection.type === 'mssql') {
        const pool = await sql.connect({ user: connection.username, password, server: connection.host, port: connection.port, database: connection.database, options: { encrypt: connection.tls, trustServerCertificate: !connection.tls }, requestTimeout: 10_000 });
        try {
            const result = await pool.request().query(`SELECT TOP 100 ${fieldSql} AS value FROM ${tableSql} WHERE ${fieldSql} IS NOT NULL GROUP BY ${fieldSql} ORDER BY ${fieldSql}`);
            return result.recordset.map((row) => row.value).filter((value): value is string | number | boolean => ['string', 'number', 'boolean'].includes(typeof value));
        } finally { await pool.close(); }
    }
    if (connection.type === 'postgresql') {
        const client = new pg.Client({ host: connection.host, port: connection.port, database: connection.database, user: connection.username, password, ssl: connection.tls ? { rejectUnauthorized: false } : false, statement_timeout: 10_000 });
        try {
            const result = await client.query(`SELECT DISTINCT ${fieldSql} AS value FROM ${tableSql} WHERE ${fieldSql} IS NOT NULL ORDER BY ${fieldSql} LIMIT 100`);
            return result.rows.map((row) => row.value).filter((value): value is string | number | boolean => ['string', 'number', 'boolean'].includes(typeof value));
        } finally { await client.end(); }
    }
    const connectionHandle = await mysql.createConnection({ host: connection.host, port: connection.port, database: connection.database, user: connection.username, password, ssl: connection.tls ? {} : undefined, connectTimeout: 10_000 });
    try {
        const [rows] = await connectionHandle.query(`SELECT DISTINCT ${fieldSql} AS value FROM ${tableSql} WHERE ${fieldSql} IS NOT NULL ORDER BY ${fieldSql} LIMIT 100`);
        return (rows as Array<{ value: unknown }>).map((row) => row.value).filter((value): value is string | number | boolean => ['string', 'number', 'boolean'].includes(typeof value));
    } finally { await connectionHandle.end(); }
}

export function quoteField(field: string, dialect: 'mssql' | 'postgresql' | 'mysql'): string {
    if (!/^[A-Za-z_][A-Za-z0-9_$]*(\.[A-Za-z_][A-Za-z0-9_$]*)?$/.test(field)) throw new Error('Filter or sort field contains invalid characters.');
    const quote = dialect === 'mssql' ? ['[', ']'] : dialect === 'mysql' ? ['`', '`'] : ['"', '"'];
    return field.split('.').map((part) => `${quote[0]}${part}${quote[1]}`).join('.');
}

export function buildSqlFilters(plan: QueryPlan, dialect: 'mssql' | 'postgresql' | 'mysql') {
    const values: Array<string | number | boolean> = [];
    const clauses = plan.filters.map((filter) => {
        const field = quoteField(filter.field, dialect);
        const index = values.push(filter.value) - 1;
        const parameter = dialect === 'mssql' ? `@p${index}` : dialect === 'postgresql' ? `$${index + 1}` : '?';
        if (filter.operator === 'contains') return dialect === 'mssql' ? `${field} LIKE '%' + ${parameter} + '%'` : dialect === 'postgresql' ? `${field} ILIKE '%' || ${parameter} || '%'` : `${field} LIKE CONCAT('%', ${parameter}, '%')`;
        const operator = { eq: '=', neq: '<>', gt: '>', gte: '>=', lt: '<', lte: '<=' }[filter.operator];
        return `${field} ${operator} ${parameter}`;
    });
    return { values, where: clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '' };
}

function selectionField(selection: SelectField): string { return selection.field; }

function groupedMeasureFields(plan: QueryPlan): string[] {
    const groupFields = new Set(plan.groupBy);
    return [...new Set(plan.select.map((selection) => selectionField(selection)).filter((field) => !groupFields.has(field)))];
}

function defaultGroupedSort(groupBy: string[], dialect: 'mssql' | 'postgresql' | 'mysql'): string {
    const field = quoteField(groupBy[0], dialect);
    if (dialect === 'mssql') return ` ORDER BY CASE WHEN ${field} IS NULL THEN 1 ELSE 0 END, ${field} ASC`;
    if (dialect === 'postgresql') return ` ORDER BY ${field} ASC NULLS LAST`;
    return ` ORDER BY ${field} IS NULL, ${field} ASC`;
}

function groupedSqlProjection(plan: QueryPlan, chart: ChartDefinition | undefined, dialect: 'mssql' | 'postgresql' | 'mysql'): { select: string; groupBy: string } {
    const groupedFields = plan.groupBy.map((field) => quoteField(field, dialect));
    if (!groupedFields.length) return { select: plan.select.length ? plan.select.map((selection) => quoteField(selectionField(selection), dialect)).join(', ') : '*', groupBy: '' };
    const aggregation = chart?.yAggregation ?? 'count';
    const measureFields = groupedMeasureFields(plan);
    if (aggregation === 'count' || aggregation === 'none' || !measureFields.length) return { select: `${groupedFields.join(', ')}, COUNT(*) AS count`, groupBy: ` GROUP BY ${groupedFields.join(', ')}` };
    const functionName = { sum: 'SUM', average: 'AVG', min: 'MIN', max: 'MAX' }[aggregation];
    const projections = measureFields.map((fieldName) => { const field = quoteField(fieldName, dialect); return `${functionName}(${field}) AS ${field}`; });
    return { select: `${groupedFields.join(', ')}, ${projections.join(', ')}`, groupBy: ` GROUP BY ${groupedFields.join(', ')}` };
}

export function buildPreviewQuery(connection: Connection, source: string, plan: QueryPlan, chart?: ChartDefinition): string {
    if (connection.type === 'mongodb') {
        if (!/^[A-Za-z0-9_.-]+$/.test(source)) throw new Error('Collection name contains invalid characters.');
        plan.select.forEach((selection) => { if (!/^[A-Za-z_][A-Za-z0-9_$]*$/.test(selectionField(selection))) throw new Error('Selected field contains invalid characters.'); });
        const filters = plan.filters.reduce<Record<string, unknown>>((result, filter) => {
            const existing = result[filter.field];
            if (filter.operator === 'contains') {
                result[filter.field] = { $regex: String(filter.value), $options: 'i' };
            } else if (filter.operator === 'eq') {
                result[filter.field] = filter.value;
            } else {
                const operator = { neq: '$ne', gt: '$gt', gte: '$gte', lt: '$lt', lte: '$lte' }[filter.operator];
                result[filter.field] = { ...(existing && typeof existing === 'object' ? existing : {}), [operator]: filter.value };
            }
            return result;
        }, {});
        if (plan.groupBy.length) {
            const group = Object.fromEntries(plan.groupBy.map((field) => {
                if (!/^[A-Za-z_][A-Za-z0-9_$]*$/.test(field)) throw new Error('Group field contains invalid characters.');
                return [field, `$${field}`];
            }));
            const aggregation = chart?.yAggregation ?? 'count';
            const measureFields = groupedMeasureFields(plan);
            const groupCalculations = aggregation === 'sum' ? Object.fromEntries(measureFields.map((field) => [field, { $sum: `$${field}` }])) : aggregation === 'average' ? Object.fromEntries(measureFields.map((field) => [field, { $avg: `$${field}` }])) : aggregation === 'min' ? Object.fromEntries(measureFields.map((field) => [field, { $min: `$${field}` }])) : aggregation === 'max' ? Object.fromEntries(measureFields.map((field) => [field, { $max: `$${field}` }])) : { count: { $sum: 1 } };
            const sortStage = plan.sort
                ? `, ${JSON.stringify({ $sort: { [plan.groupBy.includes(plan.sort.field) ? `_id.${plan.sort.field}` : plan.sort.field]: plan.sort.direction === 'asc' ? 1 : -1 } })}`
                : `, ${JSON.stringify({ $set: { __categoryNullRank: { $cond: [{ $eq: [`$_id.${plan.groupBy[0]}`, null] }, 1, 0] } } })}, ${JSON.stringify({ $sort: { __categoryNullRank: 1, [`_id.${plan.groupBy[0]}`]: 1 } })}`;
            return `db.${source}.aggregate([${JSON.stringify({ $match: filters })}, ${JSON.stringify({ $group: { _id: group, ...groupCalculations } })}${sortStage}])`;
        }
        const sort = plan.sort ? `.sort(${JSON.stringify({ [plan.sort.field]: plan.sort.direction === 'asc' ? 1 : -1 })})` : '';
        const projection = plan.select.length ? `, ${JSON.stringify(Object.fromEntries(plan.select.map((selection) => [selectionField(selection), 1])))}` : '';
        return `db.${source}.find(${JSON.stringify(filters)}${projection})${sort}.skip(${(plan.page - 1) * plan.pageSize}).limit(${plan.pageSize})`;
    }
    const dialect = connection.type;
    const filters = buildSqlFilters(plan, dialect);
    const table = dialect === 'mssql' ? quoteIdentifier(source) : quoteField(source, dialect);
    const projection = groupedSqlProjection(plan, chart, dialect);
    const sort = plan.sort
        ? ` ORDER BY ${quoteField(plan.sort.field, dialect)} ${plan.sort.direction.toUpperCase()}`
        : plan.groupBy.length ? defaultGroupedSort(plan.groupBy, dialect) : dialect === 'mssql' ? ' ORDER BY (SELECT NULL)' : '';
    const pagination = dialect === 'mssql'
        ? ` OFFSET ${(plan.page - 1) * plan.pageSize} ROWS FETCH NEXT ${plan.pageSize} ROWS ONLY`
        : ` LIMIT ${plan.pageSize} OFFSET ${(plan.page - 1) * plan.pageSize}`;
    return `SELECT ${projection.select} FROM ${table}${filters.where}${projection.groupBy}${sort}${pagination}`;
}

export function buildPreviewParameters(connection: Connection, plan: QueryPlan): Array<string | number | boolean> {
    return connection.type === 'mongodb' ? [] : buildSqlFilters(plan, connection.type).values;
}

export async function queryPreview(connection: Connection, source: string, plan: QueryPlan, chart?: ChartDefinition): Promise<Array<Record<string, string | number>>> {
    const password = connection.password ? decrypt(connection.password) : '';
    if (connection.type === 'mongodb') {
        if (!/^[A-Za-z0-9_.-]+$/.test(source)) throw new Error('Collection name contains invalid characters.');
        const client = new MongoClient(mongoConnectionUri(connection, password), { tls: connection.tls, serverSelectionTimeoutMS: 10_000 });
        try {
            await client.connect();
            const filters = plan.filters.reduce<Record<string, unknown>>((result, filter) => {
                if (!/^[A-Za-z_][A-Za-z0-9_$]*$/.test(filter.field)) throw new Error('Filter field contains invalid characters.');
                const value = filter.type === 'datetime' && typeof filter.value === 'string' ? new Date(`${filter.value.replace(' ', 'T')}Z`) : filter.value;
                const mongoOperator = filter.operator === 'contains' ? undefined : ({ eq: '$eq', neq: '$ne', gt: '$gt', gte: '$gte', lt: '$lt', lte: '$lte' }[filter.operator]);
                if (filter.operator === 'contains') {
                    result[filter.field] = { $regex: String(filter.value), $options: 'i' };
                } else if (filter.operator === 'eq') {
                    result[filter.field] = value;
                } else {
                    const existing = result[filter.field];
                    result[filter.field] = { ...(existing && typeof existing === 'object' ? existing : {}), [mongoOperator!]: value };
                }
                return result;
            }, {});
            if (plan.groupBy.length) {
                const groupId = Object.fromEntries(plan.groupBy.map((field) => {
                    if (!/^[A-Za-z_][A-Za-z0-9_$]*$/.test(field)) throw new Error('Group field contains invalid characters.');
                    return [field, `$${field}`];
                }));
                const measureFields = groupedMeasureFields(plan);
                const groupCalculations = chart?.yAggregation === 'sum' ? Object.fromEntries(measureFields.map((field) => [field, { $sum: `$${field}` }])) : chart?.yAggregation === 'average' ? Object.fromEntries(measureFields.map((field) => [field, { $avg: `$${field}` }])) : chart?.yAggregation === 'min' ? Object.fromEntries(measureFields.map((field) => [field, { $min: `$${field}` }])) : chart?.yAggregation === 'max' ? Object.fromEntries(measureFields.map((field) => [field, { $max: `$${field}` }])) : { count: { $sum: 1 } };
                const grouped = await client.db(connection.database).collection(source).aggregate([
                    { $match: filters },
                    { $group: { _id: groupId, ...groupCalculations } },
                    ...(plan.sort ? [{ $sort: { [plan.groupBy.includes(plan.sort.field) ? `_id.${plan.sort.field}` : plan.sort.field]: plan.sort.direction === 'asc' ? 1 : -1 } }] : [{ $set: { __categoryNullRank: { $cond: [{ $eq: [`$_id.${plan.groupBy[0]}`, null] }, 1, 0] } } }, { $sort: { __categoryNullRank: 1, [`_id.${plan.groupBy[0]}`]: 1 } }]),
                    { $skip: (plan.page - 1) * plan.pageSize },
                    { $limit: plan.pageSize }
                ]).toArray();
                const normalized = grouped.map((row) => ({ ...row._id as Record<string, unknown>, ...Object.fromEntries(Object.entries(row).filter(([key]) => key !== '_id' && key !== '__categoryNullRank')) }));
                if (!plan.sort) normalized.sort((left, right) => {
                    const leftValue = left[plan.groupBy[0]];
                    const rightValue = right[plan.groupBy[0]];
                    if (leftValue == null && rightValue == null) return 0;
                    if (leftValue == null) return 1;
                    if (rightValue == null) return -1;
                    return String(leftValue).localeCompare(String(rightValue), undefined, { numeric: true });
                });
                return normalized;
            }
            plan.select.forEach((selection) => { if (!/^[A-Za-z_][A-Za-z0-9_$]*$/.test(selectionField(selection))) throw new Error('Selected field contains invalid characters.'); });
            const projection = plan.select.length ? { projection: Object.fromEntries(plan.select.map((selection) => [selectionField(selection), 1])) } : undefined;
            const cursor = client.db(connection.database).collection(source).find(filters, projection).skip((plan.page - 1) * plan.pageSize).limit(plan.pageSize);
            if (plan.sort) cursor.sort({ [plan.sort.field]: plan.sort.direction === 'asc' ? 1 : -1 });
            const documents = await cursor.toArray();
            return documents.map(normalizePreview);
        } finally {
            await client.close();
        }
    }

    if (connection.type === 'mssql') {
        const pool = await sql.connect({ user: connection.username, password, server: connection.host, port: connection.port, database: connection.database, options: { encrypt: connection.tls, trustServerCertificate: !connection.tls }, requestTimeout: 10_000 });
        try {
            const filters = buildSqlFilters(plan, 'mssql');
            const requestHandle = pool.request();
            filters.values.forEach((value, index) => requestHandle.input(`p${index}`, value));
            const projection = groupedSqlProjection(plan, chart, 'mssql');
            const sort = plan.sort
                ? ` ORDER BY ${quoteField(plan.sort.field, 'mssql')} ${plan.sort.direction.toUpperCase()}`
                : plan.groupBy.length ? defaultGroupedSort(plan.groupBy, 'mssql') : ' ORDER BY (SELECT NULL)';
            const result = await requestHandle.query(`SELECT ${projection.select} FROM ${quoteIdentifier(source)}${filters.where}${projection.groupBy}${sort} OFFSET ${(plan.page - 1) * plan.pageSize} ROWS FETCH NEXT ${plan.pageSize} ROWS ONLY`);
            return result.recordset.map(normalizePreview);
        } finally {
            await pool.close();
        }
    }

    if (connection.type === 'postgresql') {
        const client = new pg.Client({ host: connection.host, port: connection.port, database: connection.database, user: connection.username, password, ssl: connection.tls ? { rejectUnauthorized: false } : false, statement_timeout: 10_000 });
        try {
            await client.connect();
            const filters = buildSqlFilters(plan, 'postgresql');
            const projection = groupedSqlProjection(plan, chart, 'postgresql');
            const sort = plan.sort ? ` ORDER BY ${quoteField(plan.sort.field, 'postgresql')} ${plan.sort.direction.toUpperCase()}` : plan.groupBy.length ? defaultGroupedSort(plan.groupBy, 'postgresql') : '';
            const result = await client.query(`SELECT ${projection.select} FROM ${quoteField(source, 'postgresql')}${filters.where}${projection.groupBy}${sort} LIMIT ${plan.pageSize} OFFSET ${(plan.page - 1) * plan.pageSize}`, filters.values);
            return result.rows.map(normalizePreview);
        } finally {
            await client.end();
        }
    }

    const connectionHandle = await mysql.createConnection({ host: connection.host, port: connection.port, database: connection.database, user: connection.username, password, ssl: connection.tls ? {} : undefined, connectTimeout: 10_000 });
    try {
        const filters = buildSqlFilters(plan, 'mysql');
        const projection = groupedSqlProjection(plan, chart, 'mysql');
        const sort = plan.sort ? ` ORDER BY ${quoteField(plan.sort.field, 'mysql')} ${plan.sort.direction.toUpperCase()}` : plan.groupBy.length ? defaultGroupedSort(plan.groupBy, 'mysql') : '';
        const [rows] = await connectionHandle.query(`SELECT ${projection.select} FROM ${quoteField(source, 'mysql')}${filters.where}${projection.groupBy}${sort} LIMIT ? OFFSET ?`, [...filters.values, plan.pageSize, (plan.page - 1) * plan.pageSize]);
        const records = rows as Array<Record<string, unknown>>;
        return records.map(normalizePreview);
    } finally {
        await connectionHandle.end();
    }
}

export async function countPreview(connection: Connection, source: string, plan: QueryPlan): Promise<number> {
    const password = connection.password ? decrypt(connection.password) : '';
    if (connection.type === 'mongodb') {
        if (!/^[A-Za-z0-9_.-]+$/.test(source)) throw new Error('Collection name contains invalid characters.');
        const client = new MongoClient(mongoConnectionUri(connection, password), { tls: connection.tls, serverSelectionTimeoutMS: 10_000 });
        try {
            await client.connect();
            const filters = plan.filters.reduce<Record<string, unknown>>((result, filter) => {
                const value = filter.type === 'datetime' && typeof filter.value === 'string' ? new Date(`${filter.value.replace(' ', 'T')}Z`) : filter.value;
                if (filter.operator === 'contains') result[filter.field] = { $regex: String(filter.value), $options: 'i' };
                else if (filter.operator === 'eq') result[filter.field] = value;
                else result[filter.field] = { [({ neq: '$ne', gt: '$gt', gte: '$gte', lt: '$lt', lte: '$lte' }[filter.operator])]: value };
                return result;
            }, {});
            if (!plan.groupBy.length) return await client.db(connection.database).collection(source).countDocuments(filters);
            const groupId = Object.fromEntries(plan.groupBy.map((field) => {
                if (!/^[A-Za-z_][A-Za-z0-9_$]*$/.test(field)) throw new Error('Group field contains invalid characters.');
                return [field, `$${field}`];
            }));
            const grouped = await client.db(connection.database).collection(source).aggregate([{ $match: filters }, { $group: { _id: groupId } }, { $count: 'total' }]).toArray();
            return Number((grouped[0] as { total?: number } | undefined)?.total ?? 0);
        } finally { await client.close(); }
    }
    const dialect = connection.type;
    const filters = buildSqlFilters(plan, dialect);
    const table = dialect === 'mssql' ? quoteIdentifier(source) : quoteField(source, dialect);
    const countQuery = plan.groupBy.length
        ? `SELECT COUNT(*) AS total FROM (SELECT ${plan.groupBy.map((field) => quoteField(field, dialect)).join(', ')} FROM ${table}${filters.where} GROUP BY ${plan.groupBy.map((field) => quoteField(field, dialect)).join(', ')}) AS grouped_results`
        : `SELECT COUNT(*) AS total FROM ${table}${filters.where}`;
    if (dialect === 'mssql') {
        const pool = await sql.connect({ user: connection.username, password, server: connection.host, port: connection.port, database: connection.database, options: { encrypt: connection.tls, trustServerCertificate: !connection.tls }, requestTimeout: 10_000 });
        try { const requestHandle = pool.request(); filters.values.forEach((value, index) => requestHandle.input(`p${index}`, value)); const result = await requestHandle.query(countQuery); return Number(result.recordset[0].total); } finally { await pool.close(); }
    }
    if (dialect === 'postgresql') {
        const client = new pg.Client({ host: connection.host, port: connection.port, database: connection.database, user: connection.username, password, ssl: connection.tls ? { rejectUnauthorized: false } : false, statement_timeout: 10_000 });
        try { await client.connect(); const result = await client.query(countQuery, filters.values); return Number(result.rows[0].total); } finally { await client.end(); }
    }
    const connectionHandle = await mysql.createConnection({ host: connection.host, port: connection.port, database: connection.database, user: connection.username, password, ssl: connection.tls ? {} : undefined, connectTimeout: 10_000 });
    try { const [rows] = await connectionHandle.query(countQuery, filters.values); return Number((rows as Array<{ total: number }>)[0].total); } finally { await connectionHandle.end(); }
}
