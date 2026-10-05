import type { FilterControl, QueryPlan, Visualization } from './models.js';
import { filterValuesSchema } from './models.js';

export function dateOnly(value: string): boolean {
    return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

export function nextDate(value: string): string {
    const [year, month, day] = value.split('-').map(Number);
    const next = new Date(Date.UTC(year, month - 1, day + 1));
    return next.toISOString().slice(0, 10);
}

export function normalizeDateTime(value: string): string {
    if (dateOnly(value)) return `${value} 00:00:00`;
    const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})(?::(\d{2})(?:\.\d+)?)?$/.exec(value);
    if (match) return `${match[1]} ${match[2]}:${match[3] ?? '00'}`;
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) throw new Error('Filter value must be a valid date or date and time.');
    return parsed.toISOString().slice(0, 19).replace('T', ' ');
}

export function normalizeTime(value: string): string {
    const match = /^(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value);
    if (!match || Number(match[1]) > 23 || Number(match[2]) > 59 || Number(match[3] ?? 0) > 59) throw new Error('Filter value must be a valid time.');
    return `${match[1]}:${match[2]}:${match[3] ?? '00'}`;
}

export function temporalFilters(field: string, operator: QueryPlan['filters'][number]['operator'], value: string, type: 'date' | 'time' | 'datetime'): QueryPlan['filters'] {
    if (type === 'time') {
        const normalized = normalizeTime(value);
        return [{ field, operator: operator === 'contains' ? 'eq' : operator, value: normalized, type }];
    }
    if (operator !== 'eq' && operator !== 'contains') return [{ field, operator, value: normalizeDateTime(value), type }];
    if (dateOnly(value)) {
        return [
            { field, operator: 'gte', value: normalizeDateTime(value), type },
            { field, operator: 'lt', value: normalizeDateTime(nextDate(value)), type }
        ];
    }
    if (operator === 'contains') {
        const start = normalizeDateTime(value);
        const end = new Date(`${start.replace(' ', 'T')}Z`);
        end.setUTCMinutes(end.getUTCMinutes() + 1);
        return [
            { field, operator: 'gte', value: start, type },
            { field, operator: 'lt', value: end.toISOString().slice(0, 19).replace('T', ' '), type }
        ];
    }
    return [{ field, operator, value: normalizeDateTime(value), type }];
}

export function applyFilterValues(visualization: Visualization, input: unknown): QueryPlan {
    const parsed = filterValuesSchema.safeParse(input);
    if (!parsed.success) throw new Error('Invalid visualization filter values.');
    const controlKey = (control: FilterControl): string => `${control.field}::${control.operator}`;
    const duplicateControls = visualization.filterControls.map(controlKey).filter((key, index, keys) => keys.indexOf(key) !== index);
    if (duplicateControls.length) throw new Error(`Visualization contains duplicate filter controls for: ${duplicateControls[0]}`);
    const controls = new Map(visualization.filterControls.map((control) => [controlKey(control), control]));
    for (const key of Object.keys(parsed.data)) if (!controls.has(key) && !visualization.filterControls.some((control) => control.field === key)) throw new Error(`Filter field is not available: ${key}`);
    const controlledFields = new Set(visualization.filterControls.map((control) => control.field));
    const filters = visualization.queryPlan.filters.filter((filter) => !controlledFields.has(filter.field));
    for (const [key, value] of Object.entries(parsed.data)) {
        if (value === null || value === '') continue;
        const control = controls.get(key) ?? controls.get(`${key}::${visualization.filterControls.find((item) => item.field === key)?.operator}`)!;
        const field = control.field;
        if (control.type === 'number' && typeof value !== 'number') throw new Error(`Filter value for ${field} must be a number.`);
        if (control.type === 'boolean' && typeof value !== 'boolean') throw new Error(`Filter value for ${field} must be true or false.`);
        if (control.type === 'text' && typeof value !== 'string') throw new Error(`Filter value for ${field} must be text.`);
        if (control.type === 'date' || control.type === 'datetime' || control.type === 'time') {
            if (typeof value !== 'string') throw new Error(`Filter value for ${field} must be a date and time.`);
            if (control.type !== 'time' && Number.isNaN(Date.parse(value))) throw new Error(`Filter value for ${field} must be a valid date and time.`);
            filters.push(...temporalFilters(field, control.operator, value, control.type));
            continue;
        }
        filters.push({ field, operator: control.operator, value, type: control.type });
    }
    return { ...visualization.queryPlan, filters, page: 1 };
}
