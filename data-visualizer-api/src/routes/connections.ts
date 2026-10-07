import type { FastifyInstance } from 'fastify';
import { metadataDb } from '../config.js';
import { connections, connectionInput, connectionUpdate, type Connection } from '../models.js';
import { encrypt, publicConnection } from '../security.js';
import { discoverSchema, listTables, verifyConnection } from '../database.js';

export function registerConnectionRoutes(app: FastifyInstance): void {
    app.get('/api/connections', async () => connections.map(publicConnection));
    
    app.post('/api/connections', async (request, reply) => {
        const parsed = connectionInput.safeParse(request.body);
        if (!parsed.success) return reply.code(400).send({ message: 'Invalid connection details', issues: parsed.error.flatten() });
        const connection: Connection = { ...parsed.data, id: crypto.randomUUID(), password: encrypt(parsed.data.password), createdAt: new Date().toISOString() };
        if (metadataDb) {
            await metadataDb.query('INSERT INTO saved_connections (id, name, type, host, port, database_name, username, encrypted_password, tls, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)', [connection.id, connection.name, connection.type, connection.host, connection.port, connection.database, connection.username, connection.password, connection.tls, connection.createdAt]);
        }
        connections.push(connection);
        return reply.code(201).send(publicConnection(connection));
    });

    app.put('/api/connections/:id', async (request, reply) => {
        const index = connections.findIndex((item) => item.id === (request.params as { id: string }).id);
        if (index < 0) return reply.code(404).send({ message: 'Connection not found' });
        const parsed = connectionUpdate.safeParse(request.body);
        if (!parsed.success) return reply.code(400).send({ message: 'Invalid connection details', issues: parsed.error.flatten() });
        const connection: Connection = { ...parsed.data, id: connections[index].id, password: parsed.data.password ? encrypt(parsed.data.password) : connections[index].password, createdAt: connections[index].createdAt };
        if (metadataDb) {
            await metadataDb.query('UPDATE saved_connections SET name = $1, type = $2, host = $3, port = $4, database_name = $5, username = $6, encrypted_password = $7, tls = $8 WHERE id = $9', [connection.name, connection.type, connection.host, connection.port, connection.database, connection.username, connection.password, connection.tls, connection.id]);
        }
        connections[index] = connection;
        return publicConnection(connection);
    });
    
    app.post('/api/connections/test', async (request, reply) => {
        const parsed = connectionInput.safeParse(request.body);
        if (!parsed.success) return reply.code(400).send({ message: 'Complete the connection details before testing.', issues: parsed.error.flatten() });
        const temporaryConnection: Connection = { ...parsed.data, id: 'connection-test', password: encrypt(parsed.data.password), createdAt: new Date().toISOString() };
        try {
            await verifyConnection(temporaryConnection);
            return { ok: true, message: `Connected successfully to ${temporaryConnection.host}:${temporaryConnection.port}` };
        } catch (error) {
            return reply.code(502).send({ ok: false, message: error instanceof Error ? error.message : 'Connection test failed.' });
        }
    });
    
    app.post('/api/connections/:id/test', async (request, reply) => {
        const connection = connections.find((item) => item.id === (request.params as { id: string }).id);
        if (!connection) return reply.code(404).send({ message: 'Connection not found' });
        try {
            await verifyConnection(connection);
            return { ok: true, message: `Connected successfully to ${connection.host}:${connection.port}` };
        } catch (error) {
            return reply.code(502).send({ ok: false, message: error instanceof Error ? error.message : 'Connection test failed.' });
        }
    });
    
    app.delete('/api/connections/:id', async (request, reply) => {
        const index = connections.findIndex((item) => item.id === (request.params as { id: string }).id);
        if (index < 0) return reply.code(404).send({ message: 'Connection not found' });
        if (metadataDb) await metadataDb.query('DELETE FROM saved_connections WHERE id = $1', [connections[index].id]);
        connections.splice(index, 1);
        return reply.code(204).send();
    });
    
    app.get('/api/schema/:connectionId', async (request, reply) => {
        const params = request.params as { connectionId: string };
        const source = String((request.query as { source?: string }).source ?? '');
        const connection = connections.find((item) => item.id === params.connectionId);
        if (!connection) return reply.code(404).send({ message: 'Connection not found' });
        if (!source) return reply.code(400).send({ message: 'A table or collection source is required.' });
        try { return { connectionId: params.connectionId, source, columns: await discoverSchema(connection, source) }; }
        catch (error) { return reply.code(502).send({ message: error instanceof Error ? error.message : 'Schema discovery failed.' }); }
    });
    
    app.get('/api/tables/:connectionId', async (request, reply) => {
        const connection = connections.find((item) => item.id === (request.params as { connectionId: string }).connectionId);
        if (!connection) return reply.code(404).send({ message: 'Connection not found' });
        try { return { connectionId: connection.id, tables: await listTables(connection) }; }
        catch (error) { return reply.code(502).send({ message: error instanceof Error ? error.message : 'Table listing failed.' }); }
    });
}
