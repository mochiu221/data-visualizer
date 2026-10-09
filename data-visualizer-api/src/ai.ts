import { z } from 'zod';
import { aiProvider } from './config.js';
import { generatedDefinition, visualizationInput } from './models.js';
import type { JoinDefinition, SchemaColumn } from './models.js';

type SampleRow = Record<string, string | number>;

export async function generateJoinFields(request: string, primarySchema: SchemaColumn[], joinedSchema: SchemaColumn[]): Promise<Pick<JoinDefinition, 'leftField' | 'rightField' | 'type'>> {
    const isDeepSeek = aiProvider === 'deepseek';
    const apiKey = isDeepSeek ? process.env.DEEPSEEK_API_KEY : process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error(`${isDeepSeek ? 'DEEPSEEK_API_KEY' : 'OPENAI_API_KEY'} is required when AI_PROVIDER=${aiProvider}.`);
    const endpoint = isDeepSeek ? 'https://api.deepseek.com/chat/completions' : `${process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1'}/chat/completions`;
    const model = process.env.AI_MODEL ?? (isDeepSeek ? 'deepseek-chat' : 'gpt-4o-mini');
    const prompt = [
        'Choose the best pair of columns to join two database tables for the user request.',
        'Return JSON only in this exact shape: {"leftField":"column from the first schema","rightField":"column from the second schema","type":"inner"|"left"}.',
        'Choose fields that represent the same entity or relationship. Prefer matching key/ID columns with compatible types and meanings.',
        'Choose "left" when the user wants to keep all rows from the first table even without a match in the second table. Otherwise choose "inner" when the request focuses on records with matching data in both tables.',
        'Use only exact column names from the provided schemas. If there is no reasonable match, return empty strings for both fields.',
        `User request: ${request}`,
        `First table schema: ${JSON.stringify(primarySchema)}`,
        `Second table schema: ${JSON.stringify(joinedSchema)}`
    ].join('\n');
    const response = await fetch(endpoint, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, temperature: 0, messages: [{ role: 'system', content: 'You select safe, semantically appropriate database join columns and return strict JSON.' }, { role: 'user', content: prompt }] })
    });
    if (!response.ok) throw new Error(`AI provider join-selection request failed with status ${response.status}.`);
    const responseBody = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
    const content = responseBody.choices?.[0]?.message?.content;
    if (!content) throw new Error('AI provider returned no join-column selection.');
    const json = content.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
    let parsedJson: unknown;
    try {
        parsedJson = JSON.parse(json);
    } catch {
        throw new Error('AI provider returned invalid JSON for join-column selection.');
    }
    const parsed = z.object({ leftField: z.string().max(80), rightField: z.string().max(80), type: z.enum(['inner', 'left']) }).safeParse(parsedJson);
    if (!parsed.success) throw new Error('AI provider returned an invalid join-column selection.');
    if (!parsed.data.leftField || !parsed.data.rightField) throw new Error('AI could not find a suitable pair of columns to join these tables.');
    if (!primarySchema.some((column) => column.name === parsed.data.leftField) || !joinedSchema.some((column) => column.name === parsed.data.rightField)) {
        throw new Error('AI selected join columns that are not present in their respective table schemas.');
    }
    return parsed.data;
}

export function parseModelJson(content: string): z.infer<typeof generatedDefinition> {
    const json = content.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
    const parsed = generatedDefinition.safeParse(JSON.parse(json));
    if (!parsed.success) throw new Error('The AI provider returned an invalid visualization payload.');
    return parsed.data;
}

export async function generateDefinition(input: z.infer<typeof visualizationInput>, schema: SchemaColumn[], sampleRows: SampleRow[] = []): Promise<z.infer<typeof generatedDefinition>> {
    const isDeepSeek = aiProvider === 'deepseek';
    const apiKey = isDeepSeek ? process.env.DEEPSEEK_API_KEY : process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error(`${isDeepSeek ? 'DEEPSEEK_API_KEY' : 'OPENAI_API_KEY'} is required when AI_PROVIDER=${aiProvider}.`);
    const endpoint = isDeepSeek ? 'https://api.deepseek.com/chat/completions' : `${process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1'}/chat/completions`;
    const model = process.env.AI_MODEL ?? (isDeepSeek ? 'deepseek-chat' : 'gpt-4o-mini');
    const prompt = [
        'Create a safe database query plan and visualization definition from the user request.',
        'Return JSON only. Never return SQL, JavaScript, executable code, or arbitrary operators.',
        'OUTPUT CONTRACT:',
        'The JSON shape must be: {"queryPlan":{"select":[{"field":string,"label":string}],"filters":[{"field":string,"operator":"eq"|"neq"|"gt"|"gte"|"lt"|"lte"|"contains","value":string|number|boolean}],"groupBy":[string],"sort":{"field":string,"direction":"asc"|"desc"}|null,"page":number,"pageSize":number},"filterControls":[{"field":string,"label":string,"type":"text"|"number"|"boolean"|"date"|"time"|"datetime","operator":"eq"|"neq"|"gt"|"gte"|"lt"|"lte"|"contains","range":"from"|"to","category":boolean}],"selectMode":"single"|"multiple","defaultSelects":[string],"title":string,"type":"bar"|"line"|"donut"|"table","chart":{"xAxis":{"field":string,"label":string,"scale":"category"|"time","timeUnit":"millisecond"|"second"|"minute"|"hour"|"day"|"week"|"month"|"quarter"|"year"},"yAxis":{"field":string,"label":string,"scale":"category"|"time"},"yAxes":[{"field":string,"label":string,"scale":"category"|"time"}],"yAggregation":"none"|"count"|"sum"|"average"|"min"|"max"}}.',
        'Use page >= 1 and pageSize between 1 and 1000.',
        '',
        'INPUT CONTEXT:',
        `Schema: ${JSON.stringify(schema)}`,
        `Example rows (up to 5, read-only sample data; use only to understand actual values and distributions): ${JSON.stringify(sampleRows.slice(0, 5))}`,
        `User request: ${input.request}`,
        '',
        'CHART TYPE:',
        '- Use line for a time series or trend where a date, timestamp, month, week, or year is the primary dimension.',
        '- Use bar for comparing values across categorical groups, ranking items, or showing multiple measures.',
        '- When the request groups by two categorical fields, use a bar chart: put the main category in queryPlan.groupBy[0] and chart.xAxis.field, put the comparison category in queryPlan.groupBy[1], and let the frontend render grouped bars for the second category.',
        '- Use donut only for a part-to-whole breakdown with a small number of categories (preferably 2 to 6); use bar when there are many categories or precise comparison matters.',
        '- Use table when the request needs row-level detail, several dimensions, several measures, or when no chart communicates the result clearly.',
        '- Do not choose a chart type solely because it is available; match the type to the query result shape and the user request.',
        '',
        'FIELDS, GROUPING, AND MEASURES:',
        '- Use queryPlan.select for the fields that should be returned. For row-level tables, include every requested detail field; use an empty array only when all source fields are needed.',
        ...(input.join ? [`- The joined field joined.${input.join.rightField} duplicates the matched key ${input.join.leftField}; do not add both to queryPlan.select. If the join key is requested, select ${input.join.leftField} from the first table instead.`] : []),
        '- Use queryPlan.groupBy for categorical or time dimensions that must be grouped before counting; every groupBy field must exist in the schema.',
        '- When queryPlan.groupBy is non-empty, include every groupBy field in queryPlan.select so grouped dimensions are visible.',
        '- For two categorical groupBy fields, preserve the requested/main dimension first and the comparison dimension second; do not put the second category in chart.yAxes because it is a bar-series category, not a numeric measure.',
        '- When grouping and the request asks for a numeric measure, use chart.yAxis.field for that measure even when it is not in groupBy, and set yAggregation to sum, average, min, or max as appropriate.',
        '- Keep groupBy empty for row-level detail or when grouping is not requested.',
        '- Every queryPlan.select field, groupBy field, and chart axis field must exist in the source schema, except chart.yAxis.field may be "count" when yAggregation is "count".',
        '',
        'SELECTION MODE AND DEFAULTS:',
        '- For any line chart, defaultSelects must contain at most three measure fields, even when the user asks to compare all measures.',
        '- For a line chart with multiple related numeric measures, include every related measure in queryPlan.select and chart.yAxes, set selectMode to "multiple", and put only the first three measures in defaultSelects.',
        '- If the user explicitly asks to compare, contrast, or show multiple measures (for example, "compare first hand count by vote date"), include all relevant numeric measures in queryPlan.select and chart.yAxes and set selectMode to "multiple". For line charts, still put only the first three measures in defaultSelects; for other chart types, include all compared measures in defaultSelects.',
        '- An explicit comparison request always overrides the broad or ambiguous measure rule: if a request combines words such as "compare" or "contrast" with a phrase such as "total amount", include all matching numeric measures, set selectMode to "multiple", and never fall back to single-select.',
        '- For other requests with more than one useful display field, set selectMode to "multiple" and include the initially visible fields in defaultSelects.',
        '- Otherwise set selectMode to "single" and include exactly one default field.',
        '- defaultSelects must contain only fields from queryPlan.select.',
        '- When the user uses a broad or ambiguous measure phrase such as "total amount" and the schema contains multiple matching numeric measure fields, include every matching measure in queryPlan.select so the frontend can offer a choice. Use single-select with only the best matching measure for chart.yAxis, omit chart.yAxes, and include only that best matching measure in defaultSelects only when the user does not explicitly ask to compare, contrast, or show all measures.',
        '- For a line chart comparing multiple numeric measures, set type to "line", provide every compared numeric measure in chart.yAxes, keep the first measure in chart.yAxis, and use one shared yAggregation for all measures.',
        '- When chart.yAxes is present, every yAxes field must be numeric, and chart.yAxis must match its first item.',
        '',
        'CHART AXES AND AGGREGATION:',
        '- Always provide chart.xAxis.field and chart.xAxis.label for the horizontal/category/time dimension.',
        '- Set chart.xAxis.scale to "time" when the x-axis field is a date, timestamp, month, week, or year time dimension; otherwise set it to "category".',
        '- When chart.xAxis.scale is "time", provide chart.xAxis.timeUnit using the most useful unit for the result, such as "day", "week", "month", or "year".',
        '- When a time-series result uses chart.xAxis.timeUnit, include the x-axis field in queryPlan.groupBy so the database aggregates rows into that time unit.',
        '- Set chart.yAxis.scale to "category"; the y-axis is numeric and the frontend configures its linear Chart.js scale.',
        '- Always provide chart.yAxis.field and chart.yAxis.label for the numeric measure.',
        '- For yAggregation "count", set chart.yAxis.field to exactly "count" because the grouped query produces COUNT(*) AS count; do not use an ID or other source field as the y-axis field.',
        '',
        'FILTER CONTROLS:',
        '- Include filterControls for useful fields the user should be able to control. Every filter control field must exist in the schema.',
        '- For date-only fields, add a filterControl with type "date". Use operator "eq" or "contains" to match the complete calendar day.',
        '- For time-only fields, add a filterControl with type "time".',
        '- For datetime, timestamp, or date-time fields, choose the filterControl type from the user intent: use type "date" for calendar-day requests such as "on 2025-01-15", "today", or "records from this date"; use type "datetime" when the time of day, exact timestamp, or a datetime boundary matters.',
        '- For a datetime field with a calendar-day request, use operator "eq" or "contains" with type "date" so the selected day matches the full day.',
        '- For datetime range requests such as after, before, greater than, or less than, use "gt", "gte", "lt", or "lte" with type "datetime" unless the user explicitly refers only to calendar dates.',
        '- For exact timestamp requests, use operator "eq" with type "datetime". Use "contains" only when the user means records occurring within that selected date or minute, not SQL text matching.',
        '- For number, date, or datetime ranges, create two filterControls for the same field: one with operator "gte" and range "from", and one with operator "lte" and range "to". Use concise labels such as "Amount from" and "Amount to".',
        '- Set filterControl.category to true only for categorical fields where the user should choose from a finite list of values; otherwise set it to false.',
        '- Do not put a user-controlled date or datetime field in queryPlan.filters; put it only in filterControls.',
        '- Do not include a field in both queryPlan.filters and filterControls. A field must be either an AI-fixed filter or a user-controlled filter.',
        '',
        'LABELS AND SAFETY:',
        '- For fields from a joined table, do not prefix the human-readable label with "joined" or "joined."; use the column name naturally.',
        '- Make every filterControl.label a concise, human-readable label based on both the field and operator, not just the raw field name. Use labels such as "Name contains", "Created after", "Created before", "Status equals", or "Amount at least"; distinguish labels when the same field has multiple operators.',
        '- Convert field names to readable words and title case where appropriate, while preserving meaningful acronyms. Do not use labels such as "Filter", "Value", or the field name alone.'
    ].join('\n');
    const response = await fetch(endpoint, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, temperature: 0, messages: [{ role: 'system', content: 'You are a strict JSON database-query and visualization-definition service.' }, { role: 'user', content: prompt }] })
    });
    if (!response.ok) throw new Error(`AI provider visualization-definition request failed with status ${response.status}.`);
    const responseBody = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
    const content = responseBody.choices?.[0]?.message?.content;
    if (!content) throw new Error('AI provider returned no visualization definition.');
    console.log('Raw visualization definition content:', content);
    const parsed = parseModelJson(content);
    console.log('Parsed visualization definition:', parsed);
    return parsed;
}
