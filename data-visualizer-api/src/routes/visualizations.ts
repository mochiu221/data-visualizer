import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { aiProvider, metadataDb } from '../config.js';
import { connections, generatedDefinition, visualizationInput, visualizations, type SchemaColumn, type Visualization } from '../models.js';
import { generateDefinition } from '../ai.js';
import { applyFilterValues } from '../filters.js';
import { buildPreviewQuery, discoverSchema, queryPreview } from '../database.js';

export function registerVisualizationRoutes(app: FastifyInstance): void {
    app.get('/api/visualizations', async () => visualizations.map(({ schema, queryPlan, ...item }) => item));
    
    app.get('/api/visualizations/:id', async (request, reply) => {
        const visualization = visualizations.find((item) => item.id === (request.params as { id: string }).id);
        if (!visualization) return reply.code(404).send({ message: 'Visualization not found' });
        try {
            const connection = connections.find((item) => item.id === visualization.connectionId);
            if (!connection) return reply.code(404).send({ message: 'The visualization connection no longer exists.' });
            const data = await queryPreview(connection, visualization.source, visualization.queryPlan);
            return { ...visualization, query: buildPreviewQuery(connection, visualization.source, visualization.queryPlan), data };
        } catch (error) {
            return reply.code(502).send({ message: error instanceof Error ? error.message : 'Visualization query failed.' });
        }
    });
    
    app.post('/api/visualizations/:id/query', async (request, reply) => {
        const visualization = visualizations.find((item) => item.id === (request.params as { id: string }).id);
        if (!visualization) return reply.code(404).send({ message: 'Visualization not found' });
        try {
            const connection = connections.find((item) => item.id === visualization.connectionId);
            if (!connection) return reply.code(404).send({ message: 'The visualization connection no longer exists.' });
            const plan = applyFilterValues(visualization, (request.body as { filters?: unknown } | undefined)?.filters ?? {});
            const data = await queryPreview(connection, visualization.source, plan);
            return { ...visualization, query: buildPreviewQuery(connection, visualization.source, plan), queryPlan: plan, data };
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Visualization query failed.';
            return reply.code(message.startsWith('Filter') || message.startsWith('Invalid') ? 400 : 502).send({ message });
        }
    });
    
    app.post('/api/visualizations/generate', async (request, reply) => {
        const parsed = visualizationInput.safeParse(request.body);
        if (!parsed.success) return reply.code(400).send({ message: 'Invalid visualization request', issues: parsed.error.flatten() });
        const connection = connections.find((item) => item.id === parsed.data.connectionId);
        if (!connection) return reply.code(404).send({ message: 'Select a saved database connection before generating a visualization.' });
        let schema: SchemaColumn[];
        try {
            schema = await discoverSchema(connection, parsed.data.source);
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Schema discovery failed.';
            app.log.error({ error: message, connectionId: connection.id, source: parsed.data.source }, 'Schema discovery failed');
            return reply.code(502).send({ message });
        }
        let definition: z.infer<typeof generatedDefinition>;
        try {
            definition = await generateDefinition(parsed.data, schema);
        } catch (error) {
            const message = error instanceof Error ? error.message : 'AI visualization definition failed.';
            app.log.error({ error: message, provider: aiProvider }, 'AI visualization definition failed');
            return reply.code(message.includes('required') ? 503 : 502).send({ message });
        }
        const schemaFields = new Set(schema.map((column) => column.name));
        const controlFields = new Set(definition.filterControls.map((control) => control.field));
        const invalidFields = [
            ...definition.filterControls.map((control) => control.field),
            ...definition.queryPlan.filters.map((filter) => filter.field),
            ...(definition.queryPlan.sort ? [definition.queryPlan.sort.field] : [])
            , ...definition.queryPlan.groupBy
            , definition.chart.xAxis.field,
            ...(definition.chart.yAggregation === 'count' && definition.chart.yAxis.field === 'count' ? [] : [definition.chart.yAxis.field])
        ].filter((field) => !schemaFields.has(field));
        if (invalidFields.length) {
            return reply.code(502).send({ message: `The AI returned a field that is not in the source schema: ${invalidFields[0]}` });
        }
        const conflicts = definition.queryPlan.filters.filter((filter) => controlFields.has(filter.field)).map((filter) => filter.field);
        if (conflicts.length) {
            return reply.code(502).send({ message: `The AI returned a conflicting filter control for: ${conflicts[0]}` });
        }
        const duplicateControls = definition.filterControls.map((control) => `${control.field}::${control.operator}`).filter((key, index, keys) => keys.indexOf(key) !== index);
        if (duplicateControls.length) {
            return reply.code(502).send({ message: `The AI returned duplicate filter controls for: ${duplicateControls[0]}` });
        }
        const now = new Date().toISOString();
        const visualization: Visualization = { ...parsed.data, type: definition.type, title: definition.title, id: crypto.randomUUID(), createdAt: now, updatedAt: now, schema, queryPlan: definition.queryPlan, filterControls: definition.filterControls, chart: definition.chart };
        if (metadataDb) {
            await metadataDb.query('INSERT INTO saved_visualizations (id, title, connection_id, source, request, type, schema_data, query_plan, filter_controls, chart_definition, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)', [visualization.id, visualization.title, visualization.connectionId, visualization.source, visualization.request, visualization.type, JSON.stringify(visualization.schema), JSON.stringify(visualization.queryPlan), JSON.stringify(visualization.filterControls), JSON.stringify(visualization.chart), visualization.createdAt, visualization.updatedAt]);
        }
        visualizations.unshift(visualization);
        return reply.code(201).send(visualization);
    });
    
    app.delete('/api/visualizations/:id', async (request, reply) => {
        const index = visualizations.findIndex((item) => item.id === (request.params as { id: string }).id);
        if (index < 0) return reply.code(404).send({ message: 'Visualization not found' });
        if (metadataDb) await metadataDb.query('DELETE FROM saved_visualizations WHERE id = $1', [visualizations[index].id]);
        visualizations.splice(index, 1);
        return reply.code(204).send();
    });
}
