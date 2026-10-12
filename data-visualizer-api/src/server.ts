import Fastify from 'fastify';
import cors from '@fastify/cors';
import { aiProvider, isAiConfigured, origin, port } from './config.js';
import { initializeStorage } from './storage.js';
import { registerConnectionRoutes } from './routes/connections.js';
import { registerVisualizationRoutes } from './routes/visualizations.js';

const app = Fastify({ logger: true });

await app.register(cors, { origin });
app.get('/health', async () => ({ status: 'ok', service: 'data-visualizer-api' }));
app.get('/api/ai/status', async () => ({ provider: aiProvider, configured: isAiConfigured() }));

registerConnectionRoutes(app);
registerVisualizationRoutes(app);

initializeStorage().then(() => app.listen({ port, host: '0.0.0.0' })).catch((error) => {
    app.log.error(error, 'Failed to initialize API storage');
    process.exitCode = 1;
});
