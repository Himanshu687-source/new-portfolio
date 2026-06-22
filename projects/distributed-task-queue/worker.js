const net = require('node:net');
const { Worker } = require('node:worker_threads');
const path = require('node:path');

const BROKER_HOST = '127.0.0.1';
const BROKER_PORT = 4000;
const CONCURRENCY = 2; // Number of parallel threads
const WORKER_ID = `worker_node_${process.pid}_${Math.random().toString(36).substring(2, 6)}`;

let client = null;
let reconnectTimer = null;
let heartbeatInterval = null;
const activeThreads = new Map(); // jobId -> Worker

function connect() {
  if (client) {
    client.destroy();
  }

  console.log(`[Worker] Connecting to broker at ${BROKER_HOST}:${BROKER_PORT}...`);
  client = net.connect({ host: BROKER_HOST, port: BROKER_PORT }, () => {
    console.log(`[Worker] Connected to Broker. Registering as ${WORKER_ID}...`);
    writeTCP({
      type: 'REGISTER_WORKER',
      workerId: WORKER_ID,
      concurrency: CONCURRENCY
    });

    // Start heartbeat
    clearInterval(heartbeatInterval);
    heartbeatInterval = setInterval(() => {
      writeTCP({ type: 'HEARTBEAT' });
    }, 10000);
  });

  let buffer = '';
  client.on('data', (data) => {
    buffer += data.toString();
    let boundary = buffer.indexOf('\n');
    while (boundary !== -1) {
      const line = buffer.substring(0, boundary).trim();
      buffer = buffer.substring(boundary + 1);

      if (line) {
        try {
          const msg = JSON.parse(line);
          handleBrokerMessage(msg);
        } catch (e) {
          console.error('[Worker] Failed to parse TCP JSON line:', line, e);
        }
      }
      boundary = buffer.indexOf('\n');
    }
  });

  client.on('close', () => {
    console.log('[Worker] Connection closed by broker. Reconnecting in 3s...');
    cleanup();
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connect, 3000);
  });

  client.on('error', (err) => {
    console.error('[Worker] TCP connection error:', err.message);
  });
}

function cleanup() {
  clearInterval(heartbeatInterval);
  // Terminate any active threads
  for (const [jobId, thread] of activeThreads.entries()) {
    thread.terminate();
    console.log(`[Worker] Terminated active job thread: ${jobId}`);
  }
  activeThreads.clear();
}

function writeTCP(obj) {
  if (client && !client.destroyed) {
    client.write(JSON.stringify(obj) + '\n');
  }
}

function handleBrokerMessage(msg) {
  switch (msg.type) {
    case 'REGISTER_ACK':
      console.log('[Worker] Registration accepted by broker.');
      break;

    case 'DISPATCH':
      console.log(`[Worker] Received dispatch for Job: ${msg.name} (ID: ${msg.jobId})`);
      runTask(msg.jobId, msg.name, msg.data);
      break;

    case 'ENQUEUE_ACK':
    case 'RESULT_ACK':
      // Handled/ignored
      break;
  }
}

function runTask(jobId, name, data) {
  const runnerPath = path.join(__dirname, 'worker_thread_runner.js');
  
  // Spawn a worker thread to handle CPU/asynchronous task without blocking the worker process event loop
  const thread = new Worker(runnerPath, {
    workerData: { jobId, name, data }
  });

  activeThreads.set(jobId, thread);

  thread.on('message', (resultMsg) => {
    // Thread sent back the final status
    console.log(`[Worker] Thread finished for ${jobId} with status: ${resultMsg.status}`);
    writeTCP({
      type: 'TASK_RESULT',
      jobId: jobId,
      status: resultMsg.status,
      result: resultMsg.result,
      error: resultMsg.error
    });
  });

  thread.on('error', (err) => {
    console.error(`[Worker] Thread error on ${jobId}:`, err);
    writeTCP({
      type: 'TASK_RESULT',
      jobId: jobId,
      status: 'FAILED',
      error: err.message || 'Worker thread execution error'
    });
  });

  thread.on('exit', (code) => {
    activeThreads.delete(jobId);
    if (code !== 0) {
      console.error(`[Worker] Worker thread for ${jobId} exited with non-zero exit code: ${code}`);
    }
  });
}

// Start worker
connect();

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('[Worker] Shutting down...');
  cleanup();
  if (client) client.end();
  process.exit(0);
});
