import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { aiProvider, metadataDb } from '../config.js';
import { connections, generatedDefinition, visualizationInput, visualizations, type SchemaColumn, type Visualization } from '../models.js';
import { generateDefinition } from '../ai.js';
import { applyFilterValues } from '../filters.js';
import { buildPreviewParameters, buildPreviewQuery, countPreview, discoverSchema, queryPreview } from '../database.js';

export function registerVisualizationRoutes(app: FastifyInstance): void {
    const drafts = new Map<string, Visualization>();
    const normalizedQueryPlan = (visualization: Visualization): Visualization['queryPlan'] => visualization.type === 'table' ? { ...visualization.queryPlan, pageSize: 20 } : visualization.queryPlan;
    const persistVisualization = async (visualization: Visualization): Promise<void> => {
        if (metadataDb) {
            await metadataDb.query('INSERT INTO saved_visualizations (id, title, connection_id, source, request, type, schema_data, query_plan, filter_controls, chart_definition, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)', [visualization.id, visualization.title, visualization.connectionId, visualization.source, visualization.request, visualization.type, JSON.stringify(visualization.schema), JSON.stringify(visualization.queryPlan), JSON.stringify(visualization.filterControls), JSON.stringify(visualization.chart), visualization.createdAt, visualization.updatedAt]);
        }
        visualizations.unshift(visualization);
    };

    app.get('/api/visualizations', async () => visualizations.map(({ schema, queryPlan, ...item }) => item));
    
    app.get('/api/visualizations/:id', async (request, reply) => {
        const visualization = visualizations.find((item) => item.id === (request.params as { id: string }).id);
        if (!visualization) return reply.code(404).send({ message: 'Visualization not found' });
        try {
            const connection = connections.find((item) => item.id === visualization.connectionId);
            if (!connection) return reply.code(404).send({ message: 'The visualization connection no longer exists.' });
            const plan = normalizedQueryPlan(visualization);
            const data = await queryPreview(connection, visualization.source, plan, visualization.chart);
            const total = visualization.type === 'table' ? await countPreview(connection, visualization.source, plan) : undefined;
            return { ...visualization, query: buildPreviewQuery(connection, visualization.source, plan, visualization.chart), queryParameters: buildPreviewParameters(connection, plan), queryPlan: plan, ...(total === undefined ? {} : { total, pagination: { page: plan.page, pageSize: plan.pageSize, total, totalPages: Math.max(1, Math.ceil(total / plan.pageSize)) } }), data };
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
            const body = request.body as { filters?: unknown; page?: unknown } | undefined;
            const plan = visualization.type === 'table' ? { ...applyFilterValues(visualization, body?.filters ?? {}), pageSize: 20 } : applyFilterValues(visualization, body?.filters ?? {});
            if (typeof body?.page === 'number' && Number.isInteger(body.page) && body.page >= 1) plan.page = body.page;
            const data = await queryPreview(connection, visualization.source, plan, visualization.chart);
            const total = visualization.type === 'table' ? await countPreview(connection, visualization.source, plan) : undefined;
            return { ...visualization, query: buildPreviewQuery(connection, visualization.source, plan, visualization.chart), queryParameters: buildPreviewParameters(connection, plan), queryPlan: plan, ...(total === undefined ? {} : { total, pagination: { page: plan.page, pageSize: plan.pageSize, total, totalPages: Math.max(1, Math.ceil(total / plan.pageSize)) } }), data };
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Visualization query failed.';
            return reply.code(message.startsWith('Filter') || message.startsWith('Invalid') ? 400 : 502).send({ message });
        }
    });
    
    app.post('/api/visualizations/confirm', async (request, reply) => {
        const parsed = z.object({ draftId: z.string().uuid() }).safeParse(request.body);
        if (!parsed.success) return reply.code(400).send({ message: 'Invalid visualization draft.' });
        const visualization = drafts.get(parsed.data.draftId);
        if (!visualization) return reply.code(404).send({ message: 'Visualization draft not found or already saved.' });
        drafts.delete(parsed.data.draftId);
        await persistVisualization(visualization);
        return reply.code(201).send(visualization);
    });

    app.post('/api/visualizations/generate', async (request, reply) => {
        const parsed = visualizationInput.safeParse(request.body);
        if (!parsed.success) return reply.code(400).send({ message: 'Invalid visualization request', issues: parsed.error.flatten() });
        const connection = connections.find((item) => item.id === parsed.data.connectionId);
        if (!connection) return reply.code(404).send({ message: 'Select a saved database connection before generating a visualization.' });
        let schema: SchemaColumn[];
        let sampleRows: Array<Record<string, string | number>>;
        try {
            schema = await discoverSchema(connection, parsed.data.source);
            sampleRows = await queryPreview(connection, parsed.data.source, { filters: [], groupBy: [], sort: null, page: 1, pageSize: 5 });
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Schema discovery or sample-row query failed.';
            app.log.error({ error: message, connectionId: connection.id, source: parsed.data.source }, 'Schema discovery or sample-row query failed');
            return reply.code(502).send({ message });
        }
        let definition: z.infer<typeof generatedDefinition>;
        try {
            definition = await generateDefinition(parsed.data, schema, sampleRows);
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
        const queryPlan = definition.type === 'table' ? { ...definition.queryPlan, pageSize: 20 } : definition.queryPlan;
        definition = { ...definition, queryPlan };
        const visualization: Visualization = { ...parsed.data, type: definition.type, title: definition.title, id: crypto.randomUUID(), createdAt: now, updatedAt: now, schema, queryPlan, filterControls: definition.filterControls, chart: definition.chart };
        const draftId = crypto.randomUUID();
        drafts.set(draftId, visualization);
        return reply.send({
            draftId,
            definition,
            visualization: {
                ...visualization,
                query: buildPreviewQuery(connection, visualization.source, visualization.queryPlan, visualization.chart),
                queryParameters: buildPreviewParameters(connection, visualization.queryPlan)
            }
        });
    });
    
    app.delete('/api/visualizations/:id', async (request, reply) => {
        const index = visualizations.findIndex((item) => item.id === (request.params as { id: string }).id);
        if (index < 0) return reply.code(404).send({ message: 'Visualization not found' });
        if (metadataDb) await metadataDb.query('DELETE FROM saved_visualizations WHERE id = $1', [visualizations[index].id]);
        visualizations.splice(index, 1);
        return reply.code(204).send();
    });
}
