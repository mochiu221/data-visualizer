import { z } from 'zod';

export const connectionInput = z.object({
    name: z.string().min(1).max(80),
    type: z.enum(['mssql', 'mongodb', 'postgresql', 'mysql']),
    host: z.string().min(1).max(253),
    port: z.number().int().min(1).max(65535),
    database: z.string().min(1).max(120),
    username: z.string().min(1).max(120),
    password: z.string().min(1).max(300),
    tls: z.boolean().default(true)
});

export const visualizationInput = z.object({
    title: z.string().min(1).max(120),
    connectionId: z.string(),
    source: z.string().min(1).max(120),
    request: z.string().min(1).max(500),
    type: z.enum(['bar', 'line', 'donut', 'table']).optional()
});

export type Connection = z.infer<typeof connectionInput> & { id: string; createdAt: string; password: string };

export type SchemaColumn = { name: string; type: string };

export type TableSource = { name: string; type: 'table' | 'view' | 'collection' };

export const filterControlSchema = z.object({
    field: z.string().min(1).max(80),
    label: z.string().min(1).max(120),
    type: z.enum(['text', 'number', 'boolean', 'date', 'time', 'datetime']),
    operator: z.enum(['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'contains']),
    range: z.enum(['from', 'to']).optional()
});

export type FilterControl = z.infer<typeof filterControlSchema>;

export const chartAxisSchema = z.object({
    field: z.string().min(1).max(80),
    label: z.string().min(1).max(120),
    scale: z.enum(['category', 'time']).default('category'),
    timeUnit: z.enum(['millisecond', 'second', 'minute', 'hour', 'day', 'week', 'month', 'quarter', 'year']).optional()
});

export const chartDefinitionSchema = z.object({
    xAxis: chartAxisSchema,
    yAxis: chartAxisSchema,
    yAggregation: z.enum(['none', 'count', 'sum', 'average', 'min', 'max']).default('none')
});

export type ChartDefinition = z.infer<typeof chartDefinitionSchema>;

export type Visualization = z.infer<typeof visualizationInput> & { id: string; createdAt: string; updatedAt: string; schema: SchemaColumn[]; queryPlan: QueryPlan; filterControls: FilterControl[]; chart?: ChartDefinition };

export const queryPlanSchema = z.object({
    filters: z.array(z.object({ field: z.string().min(1).max(80), operator: z.enum(['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'contains']), value: z.union([z.string(), z.number(), z.boolean()]), type: z.enum(['text', 'number', 'boolean', 'date', 'time', 'datetime']).optional() })).max(10).default([]),
    groupBy: z.array(z.string().min(1).max(80)).max(5).default([]),
    sort: z.object({ field: z.string().min(1).max(80), direction: z.enum(['asc', 'desc']) }).nullable().default(null),
    page: z.number().int().min(1).max(1000).default(1),
    pageSize: z.number().int().min(1).max(1000).default(25)
});

export const generatedDefinition = z.object({
    queryPlan: queryPlanSchema,
    filterControls: z.array(filterControlSchema).max(10).default([]),
    title: z.string().min(1).max(120),
    type: z.enum(['bar', 'line', 'donut', 'table']),
    chart: chartDefinitionSchema
});

export type QueryPlan = z.infer<typeof queryPlanSchema>;

export const filterValuesSchema = z.record(z.union([z.string(), z.number(), z.boolean(), z.null()]));

export const connections: Connection[] = [];

export const visualizations: Visualization[] = [];
