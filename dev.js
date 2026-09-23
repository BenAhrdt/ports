import './server.js';
import { createServer } from 'vite';

const vite = await createServer({
  server: { host: '0.0.0.0' },
});

await vite.listen();
vite.printUrls();
