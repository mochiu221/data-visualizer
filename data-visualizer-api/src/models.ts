import { z } from 'zod';

const connectionFields = z.object({
    name: z.string().min(1).max(80),
    type: z.enum(['mssql', 'mongodb', 'postgresql', 'mysql']),
    host: z.string().min(1).max(253),
    port: z.number().int().min(1).max(65535),
    database: z.string().min(1).max(120),
    username: z.string().max(120),
    password: z.string().max(300),
    tls: z.boolean().default(true)
});

function requireCredentialsForSql(value: { type: string; username?: string; password?: string }, context: z.RefinementCtx): void {
    if (value.type !== 'mongodb' && !value.username) context.addIssue({ code: z.ZodIssueCode.custom, path: ['username'], message: 'Username is required for this database type.' });
    if (value.type !== 'mongodb' && !value.password) context.addIssue({ code: z.ZodIssueCode.custom, path: ['password'], message: 'Password is required for this database type.' });
}

export const connectionInput = connectionFields.superRefine(requireCredentialsForSql);
export const connectionUpdate = connectionFields.extend({ password: z.string().max(300).optional() }).superRefine((value, context) => {
    if (value.type !== 'mongodb' && !value.username) context.addIssue({ code: z.ZodIssueCode.custom, path: ['username'], message: 'Username is required for this database type.' });
});

export const joinSchema = z.object({ source: z.string().min(1).max(120), leftField: z.string().min(1).max(80), rightField: z.string().min(1).max(80), type: z.enum(['inner', 'left']).default('inner') });
const joinInputSchema = z.object({
    source: z.string().min(1).max(120),
    leftField: z.string().min(1).max(80).optional(),
    rightField: z.string().min(1).max(80).optional(),
    type: z.enum(['inner', 'left']).optional()
}).superRefine((join, context) => {
    if (Boolean(join.leftField) !== Boolean(join.rightField)) context.addIssue({ code: z.ZodIssueCode.custom, message: 'Provide both join fields or let AI choose both.' });
});
export const visualizationInput = z.object({
    title: z.string().min(1).max(120),
    connectionId: z.string(),
    source: z.string().min(1).max(120),
    join: joinInputSchema.optional(),
    request: z.string().min(1).max(500),
    type: z.enum(['bar', 'line', 'donut', 'table']).optional()
});
export type JoinDefinition = z.infer<typeof joinSchema>;

export type Connection = z.infer<typeof connectionInput> & { id: string; createdAt: string; password: string };

export type SchemaColumn = { name: string; type: string };

export type TableSource = { name: string; type: 'table' | 'view' | 'collection' };

export const filterControlSchema = z.object({
    field: z.string().min(1).max(80),
    label: z.string().min(1).max(120),
    type: z.enum(['text', 'number', 'boolean', 'date', 'time', 'datetime']),
    operator: z.enum(['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'contains']),
    range: z.enum(['from', 'to']).optional(),
    category: z.boolean().default(false)
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
    yAxes: z.array(chartAxisSchema).max(50).optional(),
    yAggregation: z.enum(['none', 'count', 'sum', 'average', 'min', 'max']).default('none')
});

export type ChartDefinition = z.infer<typeof chartDefinitionSchema>;

export type Visualization = Omit<z.infer<typeof visualizationInput>, 'join'> & { join?: JoinDefinition; id: string; createdAt: string; updatedAt: string; schema: SchemaColumn[]; queryPlan: QueryPlan; filterControls: FilterControl[]; selectMode: SelectMode; defaultSelects: string[]; chart?: ChartDefinition };

export const selectFieldSchema = z.object({
    field: z.string().min(1).max(80),
    label: z.string().min(1).max(80).optional()
});
export type SelectField = z.infer<typeof selectFieldSchema>;

const queryFilterSchema = z.object({
    field: z.string().min(1).max(80),
    operator: z.enum(['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'contains']),
    value: z.union([z.string(), z.number(), z.boolean()]),
    type: z.enum(['text', 'number', 'boolean', 'date', 'time', 'datetime']).optional()
});

export const queryPlanSchema = z.object({
    select: z.array(selectFieldSchema).max(50).default([]),
    filters: z.array(queryFilterSchema).max(10).optional(),
    filterGroups: z.array(z.array(queryFilterSchema).min(1).max(20)).max(10).default([]),
    groupBy: z.array(z.string().min(1).max(80)).max(5).default([]),
    sort: z.object({ field: z.string().min(1).max(80), direction: z.enum(['asc', 'desc']) }).nullable().default(null),
    page: z.number().int().min(1).default(1),
    pageSize: z.number().int().min(1).max(1000).default(20)
}).transform(({ filters, filterGroups, ...plan }) => ({
    ...plan,
    filterGroups: filters?.length
        ? filterGroups.length
            ? filterGroups.map((group) => [...filters, ...group])
            : [filters]
        : filterGroups
}));

export const generatedDefinition = z.object({
    queryPlan: queryPlanSchema,
    filterControls: z.array(filterControlSchema).max(10).default([]),
    selectMode: z.enum(['single', 'multiple']).default('single'),
    defaultSelects: z.array(z.string().min(1).max(80)).max(50).default([]),
    title: z.string().min(1).max(120),
    type: z.enum(['bar', 'line', 'donut', 'table']),
    chart: chartDefinitionSchema
});

export type SelectMode = z.infer<typeof generatedDefinition>['selectMode'];

export type QueryPlan = z.infer<typeof queryPlanSchema>;

export const filterValuesSchema = z.record(z.union([z.string(), z.number(), z.boolean(), z.null()]));

export const connections: Connection[] = [];

export const visualizations: Visualization[] = [];
