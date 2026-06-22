const net = require('node:net');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { WebSocketServer } = require('ws');

// Configuration
const TCP_PORT = 4000;
const HTTP_PORT = 3050;
const DB_PATH = path.join(__dirname, 'queue.db');

// Initialize SQLite Database
const db = new DatabaseSync(DB_PATH);
console.log('Database initialized at:', DB_PATH);

// Setup database schema
db.exec(`
  CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    data TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('pending', 'scheduled', 'running', 'completed', 'failed')),
    retries INTEGER DEFAULT 0,
    max_retries INTEGER DEFAULT 3,
    delay INTEGER DEFAULT 0,
    run_at INTEGER NOT NULL,
    worker_id TEXT,
    result TEXT,
    error TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS workers (
    id TEXT PRIMARY KEY,
    concurrency INTEGER DEFAULT 1,
    active_jobs INTEGER DEFAULT 0,
    last_seen INTEGER NOT NULL
  )
`);

// Reset stale running jobs to pending on startup
db.exec(`
  UPDATE jobs 
  SET status = 'pending', worker_id = NULL, updated_at = ? 
  WHERE status = 'running'
`, [Date.now()]);

// Clear all active jobs on workers on startup
db.exec(`DELETE FROM workers`);

// Active TCP connections for workers
const activeWorkers = new Map(); // workerId -> { socket, info }
// Active dashboard sockets
const dashboardSockets = new Set();

// Utility database queries
const queryInsertJob = db.prepare(`
  INSERT INTO jobs (id, name, data, status, retries, max_retries, delay, run_at, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const queryGetJob = db.prepare(`
  SELECT * FROM jobs WHERE id = ?
`);

const queryUpdateJobStatus = db.prepare(`
  UPDATE jobs 
  SET status = ?, worker_id = ?, result = ?, error = ?, retries = ?, run_at = ?, updated_at = ? 
  WHERE id = ?
`);

const queryNextPendingJob = db.prepare(`
  SELECT * FROM jobs 
  WHERE status = 'pending' 
  ORDER BY created_at ASC 
  LIMIT 1
`);

const queryScheduledJobsToRun = db.prepare(`
  SELECT id FROM jobs 
  WHERE status = 'scheduled' AND run_at <= ?
`);

const queryUpdateJobsToPending = db.prepare(`
  UPDATE jobs 
  SET status = 'pending', updated_at = ? 
  WHERE id = ?
`);

const queryUpsertWorker = db.prepare(`
  INSERT INTO workers (id, concurrency, active_jobs, last_seen)
  VALUES (?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    concurrency = excluded.concurrency,
    active_jobs = excluded.active_jobs,
    last_seen = excluded.last_seen
`);

const queryDeleteWorker = db.prepare(`
  DELETE FROM workers WHERE id = ?
`);

const queryIncrementWorkerActive = db.prepare(`
  UPDATE workers SET active_jobs = active_jobs + 1, last_seen = ? WHERE id = ?
`);

const queryDecrementWorkerActive = db.prepare(`
  UPDATE workers SET active_jobs = MAX(0, active_jobs - 1), last_seen = ? WHERE id = ?
`);

const queryGetActiveWorkersList = db.prepare(`
  SELECT * FROM workers
`);

const queryGetStats = db.prepare(`
  SELECT 
    COUNT(CASE WHEN status = 'pending' THEN 1 END) as pending,
    COUNT(CASE WHEN status = 'scheduled' THEN 1 END) as scheduled,
    COUNT(CASE WHEN status = 'running' THEN 1 END) as running,
    COUNT(CASE WHEN status = 'completed' THEN 1 END) as completed,
    COUNT(CASE WHEN status = 'failed' THEN 1 END) as failed
  FROM jobs
`);

const queryRecentJobs = db.prepare(`
  SELECT id, name, status, retries, max_retries, delay, run_at, worker_id, result, error, created_at
  FROM jobs
  ORDER BY created_at DESC
  LIMIT 30
`);

// Broadcast state to all connected dashboard clients
function broadcastToDashboards() {
  if (dashboardSockets.size === 0) return;

  const stats = queryGetStats.get();
  const recentJobs = queryRecentJobs.all();
  const dbWorkers = queryGetActiveWorkersList.all();

  // Populate actual online state
  const workers = dbWorkers.map(w => ({
    ...w,
    online: activeWorkers.has(w.id)
  }));

  const payload = JSON.stringify({
    type: 'STATS_UPDATE',
    stats,
    workers,
    recentJobs
  });

  for (const ws of dashboardSockets) {
    if (ws.readyState === ws.OPEN) {
      ws.send(payload);
    }
  }
}

// Check and trigger scheduled jobs
function checkScheduledJobs() {
  const now = Date.now();
  const due = queryScheduledJobsToRun.all(now);

  for (const job of due) {
    queryUpdateJobsToPending.run(now, job.id);
    console.log(`[Scheduler] Job ${job.id} released from schedule.`);
  }

  if (due.length > 0) {
    processQueue();
    broadcastToDashboards();
  }
}
setInterval(checkScheduledJobs, 500);

// Distribute pending jobs to idle workers
function processQueue() {
  // Find a worker that has capacity
  const dbWorkers = queryGetActiveWorkersList.all();
  const availableWorker = dbWorkers.find(w => {
    const isOnline = activeWorkers.has(w.id);
    const hasCapacity = w.active_jobs < w.concurrency;
    return isOnline && hasCapacity;
  });

  if (!availableWorker) return;

  // Get next pending job
  const job = queryNextPendingJob.get();
  if (!job) return;

  // Assign job to worker
  const now = Date.now();
  queryUpdateJobStatus.run(
    'running',
    availableWorker.id,
    null,
    null,
    job.retries,
    job.run_at,
    now,
    job.id
  );
  queryIncrementWorkerActive.run(now, availableWorker.id);

  const worker = activeWorkers.get(availableWorker.id);
  console.log(`[Broker] Dispatching job ${job.name} (${job.id}) to worker ${availableWorker.id}`);

  // Send over TCP to the worker
  writeTCP(worker.socket, {
    type: 'DISPATCH',
    jobId: job.id,
    name: job.name,
    data: JSON.parse(job.data)
  });

  broadcastToDashboards();

  // Check if there are more jobs and capacity to handle immediately
  setImmediate(processQueue);
}

// TCP helper to send JSON line
function writeTCP(socket, obj) {
  if (!socket.destroyed) {
    socket.write(JSON.stringify(obj) + '\n');
  }
}

// Handle Broker Client Connections (Producers and Workers)
const tcpServer = net.createServer((socket) => {
  let buffer = '';
  let registeredWorkerId = null;

  socket.on('data', (data) => {
    buffer += data.toString();
    let boundary = buffer.indexOf('\n');

    while (boundary !== -1) {
      const line = buffer.substring(0, boundary).trim();
      buffer = buffer.substring(boundary + 1);

      if (line) {
        try {
          const msg = JSON.parse(line);
          handleTCPMessage(socket, msg);
        } catch (e) {
          console.error('[Broker] Failed to parse TCP frame:', line, e);
        }
      }
      boundary = buffer.indexOf('\n');
    }
  });

  function handleTCPMessage(socket, msg) {
    const now = Date.now();

    switch (msg.type) {
      case 'ENQUEUE': {
        const jobId = msg.jobId || `job_${Math.random().toString(36).substring(2, 11)}`;
        const status = msg.options?.delay > 0 ? 'scheduled' : 'pending';
        const runAt = now + (msg.options?.delay || 0);
        const maxRetries = msg.options?.retries ?? 3;

        queryInsertJob.run(
          jobId,
          msg.name,
          JSON.stringify(msg.data || {}),
          status,
          0,
          maxRetries,
          msg.options?.delay || 0,
          runAt,
          now,
          now
        );

        console.log(`[Broker] Enqueued job ${msg.name} (${jobId}) [Status: ${status}]`);
        writeTCP(socket, { type: 'ENQUEUE_ACK', jobId });
        
        processQueue();
        broadcastToDashboards();
        break;
      }

      case 'REGISTER_WORKER': {
        registeredWorkerId = msg.workerId;
        const concurrency = msg.concurrency || 1;
        
        queryUpsertWorker.run(registeredWorkerId, concurrency, 0, now);
        activeWorkers.set(registeredWorkerId, { socket, concurrency });
        
        console.log(`[Broker] Worker registered: ${registeredWorkerId} (Concurrency: ${concurrency})`);
        writeTCP(socket, { type: 'REGISTER_ACK' });
        
        processQueue();
        broadcastToDashboards();
        break;
      }

      case 'HEARTBEAT': {
        if (registeredWorkerId) {
          // Update last seen
          db.prepare(`UPDATE workers SET last_seen = ? WHERE id = ?`).run(now, registeredWorkerId);
        }
        break;
      }

      case 'TASK_RESULT': {
        const { jobId, status, result, error } = msg;
        console.log(`[Broker] Task result received for ${jobId}: ${status}`);

        const job = queryGetJob.get(jobId);
        if (!job) {
          console.error(`[Broker] Job ${jobId} not found for result reporting.`);
          return;
        }

        if (status === 'COMPLETED') {
          queryUpdateJobStatus.run(
            'completed',
            null,
            JSON.stringify(result || null),
            null,
            job.retries,
            job.run_at,
            now,
            jobId
          );
        } else {
          // FAILED - check retries
          if (job.retries < job.max_retries) {
            const nextRetryAttempt = job.retries + 1;
            // Exponential backoff: 2s * 2^attempt
            const backoffDelay = 2000 * Math.pow(2, nextRetryAttempt);
            const runAt = now + backoffDelay;

            queryUpdateJobStatus.run(
              'scheduled',
              null,
              null,
              error || 'Unknown Error',
              nextRetryAttempt,
              runAt,
              now,
              jobId
            );
            console.log(`[Broker] Job ${jobId} failed. Scheduled retry #${nextRetryAttempt} in ${backoffDelay}ms.`);
          } else {
            queryUpdateJobStatus.run(
              'failed',
              null,
              null,
              error || 'Out of retries',
              job.retries,
              job.run_at,
              now,
              jobId
            );
            console.log(`[Broker] Job ${jobId} permanently failed. Exceeded max retries.`);
          }
        }

        // Decrement worker active load
        if (registeredWorkerId) {
          queryDecrementWorkerActive.run(now, registeredWorkerId);
        }

        writeTCP(socket, { type: 'RESULT_ACK', jobId });

        // Trigger next job check since worker is now free
        processQueue();
        broadcastToDashboards();
        break;
      }
    }
  }

  socket.on('close', () => {
    if (registeredWorkerId) {
      console.log(`[Broker] Worker disconnected: ${registeredWorkerId}`);
      activeWorkers.delete(registeredWorkerId);
      queryDeleteWorker.run(registeredWorkerId);

      // Re-queue any running tasks on this worker
      const now = Date.now();
      const stmt = db.prepare(`SELECT id, retries, max_retries FROM jobs WHERE worker_id = ? AND status = 'running'`);
      const staleJobs = stmt.all(registeredWorkerId);

      for (const job of staleJobs) {
        if (job.retries < job.max_retries) {
          const nextRetry = job.retries + 1;
          const runAt = now + 1000; // run soon
          queryUpdateJobStatus.run('scheduled', null, null, 'Worker disconnected abruptly', nextRetry, runAt, now, job.id);
        } else {
          queryUpdateJobStatus.run('failed', null, null, 'Worker disconnected (no retries left)', job.retries, job.run_at, now, job.id);
        }
      }

      processQueue();
      broadcastToDashboards();
    }
  });

  socket.on('error', (err) => {
    console.error(`[Broker] Socket error on ${registeredWorkerId || 'unknown'}:`, err.message);
  });
});

// Start TCP Server
tcpServer.listen(TCP_PORT, () => {
  console.log(`[Broker] TCP server listening on port ${TCP_PORT}`);
});

// HTTP server for static Dashboard serving
const httpServer = http.createServer((req, res) => {
  let filePath = path.join(__dirname, 'dashboard', req.url === '/' ? 'index.html' : req.url);
  
  // Guard against directory traversal
  const relative = path.relative(path.join(__dirname, 'dashboard'), filePath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  const extname = String(path.extname(filePath)).toLowerCase();
  const mimeTypes = {
    '.html': 'text/html',
    '.js': 'text/javascript',
    '.css': 'text/css',
    '.json': 'application/json',
    '.png': 'image/png',
    '.jpg': 'image/jpg',
  };

  const contentType = mimeTypes[extname] || 'application/octet-stream';

  fs.readFile(filePath, (error, content) => {
    if (error) {
      if (error.code === 'ENOENT') {
        res.writeHead(404, { 'Content-Type': 'text/html' });
        res.end('<h1>404 Not Found</h1>', 'utf-8');
      } else {
        res.writeHead(500);
        res.end(`Server Error: ${error.code} ..\n`);
      }
    } else {
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(content, 'utf-8');
    }
  });
});

// WebSockets Server for dashboard live state pushes
const wss = new WebSocketServer({ server: httpServer });

wss.on('connection', (ws) => {
  dashboardSockets.add(ws);
  console.log('[Dashboard] New web client connected. Total clients:', dashboardSockets.size);

  // Send initial stats load
  const stats = queryGetStats.get();
  const recentJobs = queryRecentJobs.all();
  const dbWorkers = queryGetActiveWorkersList.all();
  const workers = dbWorkers.map(w => ({
    ...w,
    online: activeWorkers.has(w.id)
  }));

  ws.send(JSON.stringify({
    type: 'STATS_UPDATE',
    stats,
    workers,
    recentJobs
  }));

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);
      if (data.type === 'TRIGGER_TEST') {
        // Enqueue mock task
        const jobId = `test_${Math.random().toString(36).substring(2, 11)}`;
        const now = Date.now();
        
        let taskName = 'heavy_computation';
        let taskData = { iterations: 10000000 };
        let options = { retries: 2, delay: 0 };

        if (data.task === 'flaky') {
          taskName = 'flaky_task';
          taskData = { failRate: 0.7 }; // 70% fail chance
          options.retries = 3;
        } else if (data.task === 'delayed') {
          taskName = 'heavy_computation';
          taskData = { iterations: 5000000 };
          options.delay = 5000; // 5 seconds
        }

        queryInsertJob.run(
          jobId,
          taskName,
          JSON.stringify(taskData),
          options.delay > 0 ? 'scheduled' : 'pending',
          0,
          options.retries,
          options.delay,
          now + options.delay,
          now,
          now
        );
        console.log(`[Dashboard] Manual trigger received. Enqueued ${taskName} (${jobId})`);
        
        processQueue();
        broadcastToDashboards();
      }
    } catch (e) {
      console.error('[Dashboard] Error processing message:', e);
    }
  });

  ws.on('close', () => {
    dashboardSockets.delete(ws);
    console.log('[Dashboard] Web client disconnected.');
  });
});

httpServer.listen(HTTP_PORT, () => {
  console.log(`[Dashboard] UI Server available at http://localhost:${HTTP_PORT}`);
});
