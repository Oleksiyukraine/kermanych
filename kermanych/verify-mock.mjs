// THROWAWAY verification harness for "+ Задача from selection".
// Serves the built SPA and a mock API (socket.io snapshot + transcript + POST log)
// so the real WorkspacePage/KPanel render a session with a "Знахідка" message.
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, normalize } from 'node:path';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const { Server } = require(
  join(here, 'node_modules/.pnpm/socket.io@4.8.3/node_modules/socket.io'),
);
const PORT = 4319;
const SPA = join(here, 'apps/ui/dist/spa');
const PORT = 4317;

const now = new Date().toISOString();
const group = { id: 'g1', name: 'Multiagent-app', projectDir: '/tmp/demo', carryFiles: ['.env'], createdAt: now };
const session = {
  id: 's1', groupId: 'g1', name: 'add-backlog-status-for-agents', task: 'Add backlog status for agents',
  worktreePath: '/tmp/wt', branch: 'feature/add-backlog-status-for-agents', worktree: true,
  kind: 'agent', status: 'done', createdAt: now, lastActivityAt: now,
};

const FINDING =
  'Знахідка (поза скоупом, не чіпав): пункт 1 — реальний баг dev-режиму pnpm dev:ui. ' +
  'Якщо на нього наткнешся — скажи, полагоджу окремо (напр. optimizeDeps.include для @kermanych/core або ESM-збірка core).';

const transcript = [
  { kind: 'user_text', text: 'Додай статус беклогу для агентів.' },
  { kind: 'assistant_text', text:
    'Готово. Внутрішнє (archived, showArchived) — не чіпав; міграції немає.\n\n' +
    'Перевірка: типчек UI — EXIT 0; артефакт production-бандла — усі підписи присутні.\n\n' +
    FINDING + '\n\n' +
    'Досі відкрито: пункт (2) «Зупинити + відкласти» для активного агента — реалізую за твоїм явним «так».' },
];

const received = [];

const mime = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.woff': 'font/woff',
};

function readBody(req) {
  return new Promise((res) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => res(b));
  });
}

const httpServer = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const path = url.pathname;
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  if (path.startsWith('/api/')) {
    res.setHeader('content-type', 'application/json; charset=utf-8');
    if (req.method === 'GET' && /^\/api\/sessions\/[^/]+\/transcript$/.test(path)) {
      res.writeHead(200); return res.end(JSON.stringify(transcript));
    }
    if (req.method === 'POST' && path === '/api/sessions') {
      const body = JSON.parse((await readBody(req)) || '{}');
      received.push(body);
      console.log('POST /api/sessions <-', JSON.stringify(body));
      const created = {
        ...session, id: 't-' + received.length, name: body.name, task: body.task,
        kind: body.asTask ? 'task' : 'agent', status: body.asTask ? 'backlog' : 'queued',
        worktreePath: '', branch: '', model: body.model, prefix: body.prefix,
        worktree: body.worktree ?? true, createdAt: new Date().toISOString(), lastActivityAt: new Date().toISOString(),
      };
      io.emit('event', { type: 'session_update', session: created });
      res.writeHead(200); return res.end(JSON.stringify(created));
    }
    // Unhandled API calls: benign empty payloads so the UI never errors out.
    res.writeHead(200); return res.end(req.method === 'GET' ? '[]' : '{}');
  }

  // Static SPA (hash-router: any non-file path serves index.html).
  let rel = normalize(path).replace(/^(\.\.[/\\])+/, '');
  if (rel === '/' || !/\.[a-z0-9]+$/i.test(rel)) rel = '/index.html';
  try {
    const file = join(SPA, rel);
    const data = await readFile(file);
    const ext = rel.slice(rel.lastIndexOf('.'));
    res.setHeader('content-type', mime[ext] ?? 'application/octet-stream');
    res.writeHead(200); res.end(data);
  } catch {
    const data = await readFile(join(SPA, 'index.html'));
    res.setHeader('content-type', mime['.html']); res.writeHead(200); res.end(data);
  }
});

const io = new Server(httpServer, { cors: { origin: '*' } });
io.on('connection', (socket) => {
  socket.emit('event', { type: 'snapshot', groups: [group], sessions: [session] });
});

httpServer.listen(PORT, '127.0.0.1', () => console.log(`mock up on http://localhost:${PORT}`));
