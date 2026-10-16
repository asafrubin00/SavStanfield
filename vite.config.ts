import { defineConfig, loadEnv, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { proxy } from './api/ext';

// Serves /api/ext in local dev the same way the Vercel function does in production.
function devApi(env: Record<string, string>): Plugin {
  return {
    name: 'dev-api',
    configureServer(server) {
      server.middlewares.use('/api/ext', async (req, res) => {
        const out = await proxy(req.url?.split('?')[1] ?? '', req.headers.authorization, env);
        res.statusCode = out.status;
        res.setHeader('Content-Type', out.type);
        res.end(out.body);
      });
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  return { plugins: [react(), devApi(env)] };
});
