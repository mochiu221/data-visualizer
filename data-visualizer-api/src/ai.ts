import { z } from 'zod';
import { aiProvider } from './config.js';
import { generatedDefinition, visualizationInput } from './models.js';
import type { SchemaColumn } from './models.js';

export function parseModelJson(content: string): z.infer<typeof generatedDefinition> {
    const json = content.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
    const parsed = generatedDefinition.safeParse(JSON.parse(json));
    if (!parsed.success) throw new Error('The AI provider returned an invalid visualization payload.');
    return parsed.data;
}

export async function generateDefinition(input: z.infer<typeof visualizationInput>, schema: SchemaColumn[]): Promise<z.infer<typeof generatedDefinition>> {
    const isDeepSeek = aiProvider === 'deepseek';
    const apiKey = isDeepSeek ? process.env.DEEPSEEK_API_KEY : process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error(`${isDeepSeek ? 'DEEPSEEK_API_KEY' : 'OPENAI_API_KEY'} is required when AI_PROVIDER=${aiProvider}.`);
    const endpoint = isDeepSeek ? 'https://api.deepseek.com/chat/completions' : `${process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1'}/chat/completions`;
    const model = process.env.AI_MODEL ?? (isDeepSeek ? 'deepseek-chat' : 'gpt-4o-mini');
    const prompt = [
        'Create a safe database query plan and visualization definition from the user request.',
        'Return JSON only. Never return SQL, JavaScript, executable code, or arbitrary operators.',
        'The JSON shape must be: {"queryPlan":{"filters":[{"field":string,"operator":"eq"|"neq"|"gt"|"gte"|"lt"|"lte"|"contains","value":string|number|boolean}],"groupBy":[string],"sort":{"field":string,"direction":"asc"|"desc"}|null,"page":number,"pageSize":number},"filterControls":[{"field":string,"label":string,"type":"text"|"number"|"boolean"|"date"|"time"|"datetime","operator":"eq"|"neq"|"gt"|"gte"|"lt"|"lte"|"contains"}],"title":string,"type":"bar"|"line"|"donut"|"table","chart":{"xAxis":{"field":string,"label":string,"scale":"category"|"time","timeUnit":"millisecond"|"second"|"minute"|"hour"|"day"|"week"|"month"|"quarter"|"year"},"yAxis":{"field":string,"label":string,"scale":"category"|"time"},"yAggregation":"none"|"count"|"sum"|"average"|"min"|"max"}}.',
        'Use page >= 1 and pageSize between 1 and 100.',
        `Schema: ${JSON.stringify(schema)}`,
        `User request: ${input.request}`,
        'Choose the chart type from the requested analysis and the available field types using these rules:',
        '- Use line for a time series or trend where a date, timestamp, month, week, or year is the primary dimension.',
        '- Use bar for comparing values across categorical groups, ranking items, or showing multiple measures.',
        '- Use donut only for a part-to-whole breakdown with a small number of categories (preferably 2 to 6); use bar when there are many categories or precise comparison matters.',
        '- Use table when the request needs row-level detail, several dimensions, several measures, or when no chart communicates the result clearly.',
        '- Do not choose a chart type solely because it is available; match the type to the query result shape and the user request.',
        '- Use queryPlan.groupBy for categorical or time dimensions that must be grouped before counting; every groupBy field must exist in the schema.',
        '- Keep groupBy empty for row-level detail or when grouping is not requested.',
        '- Always provide chart.xAxis.field and chart.xAxis.label for the horizontal/category/time dimension.',
        '- Set chart.xAxis.scale to "time" when the x-axis field is a date, timestamp, month, week, or year time dimension; otherwise set it to "category".',
        '- When chart.xAxis.scale is "time", provide chart.xAxis.timeUnit using the most useful unit for the result, such as "day", "week", "month", or "year".',
        '- Set chart.yAxis.scale to "category"; the y-axis is numeric and the frontend configures its linear Chart.js scale.',
        '- Always provide chart.yAxis.field and chart.yAxis.label for the numeric measure.',
        '- Every x-axis field must exist in the source schema. For yAggregation "none", "sum", "average", "min", or "max", the y-axis field must also exist in the source schema.',
        '- For yAggregation "count", set chart.yAxis.field to exactly "count" because the grouped query produces COUNT(*) AS count; do not use an ID or other source field as the y-axis field.',
        '- For date-only fields, add a filterControl with type "date". Use operator "eq" or "contains" to match the complete calendar day.',
        '- For time-only fields, add a filterControl with type "time".',
        '- For datetime, timestamp, or date-time fields, add a filterControl with type "datetime".',
        '- For datetime range requests such as after, before, greater than, or less than, use "gt", "gte", "lt", or "lte" with a datetime filterControl.',
        '- Use "contains" for a date or datetime value when the user means records occurring within that selected date or minute, not SQL text matching.',
        '- Do not put a user-controlled date or datetime field in queryPlan.filters; put it only in filterControls.',
        'Include filterControls for useful fields the user should be able to control. Every filter control field must exist in the schema.',
        'Make every filterControl.label a concise, human-readable label based on both the field and operator, not just the raw field name. Use labels such as "Name contains", "Created after", "Created before", "Status equals", or "Amount at least"; distinguish labels when the same field has multiple operators.',
        'Convert field names to readable words and title case where appropriate, while preserving meaningful acronyms. Do not use labels such as "Filter", "Value", or the field name alone.',
        'Do not include a field in both queryPlan.filters and filterControls. A field must be either an AI-fixed filter or a user-controlled filter.'
    ].join('\n');
    const response = await fetch(endpoint, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, temperature: 0, messages: [{ role: 'system', content: 'You are a strict JSON database-query and visualization-definition service.' }, { role: 'user', content: prompt }] }),
        signal: AbortSignal.timeout(20_000)
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
