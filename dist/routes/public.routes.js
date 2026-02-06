export async function publicRoutes(app) {
    app.get('/', async (req, reply) => {
        return reply.sendFile('index.html');
    });
    app.get('/policy', async (req, reply) => {
        return reply.sendFile('policy.html');
    });
    app.get('/api/health', async () => ({ ok: true }));
}
