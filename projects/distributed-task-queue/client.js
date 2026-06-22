const net = require('node:net');

class QueueClient {
  constructor(port = 4000, host = '127.0.0.1') {
    this.port = port;
    this.host = host;
  }

  /**
   * Enqueue a job into the distributed task queue
   * @param {string} taskName - Name of the task (matching files in tasks/)
   * @param {object} data - Arguments to pass to the task function
   * @param {object} options - Execution configurations (delay, retries)
   */
  enqueue(taskName, data = {}, options = { retries: 3, delay: 0 }) {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection({ port: this.port, host: this.host }, () => {
        const jobId = `job_${Math.random().toString(36).substring(2, 11)}`;
        const payload = JSON.stringify({
          type: 'ENQUEUE',
          jobId,
          name: taskName,
          data,
          options
        }) + '\n';
        
        socket.write(payload);
      });

      let responseBuffer = '';
      socket.on('data', (chunk) => {
        responseBuffer += chunk.toString();
        if (responseBuffer.includes('\n')) {
          try {
            const res = JSON.parse(responseBuffer.trim());
            socket.end();
            resolve(res);
          } catch (e) {
            socket.end();
            reject(new Error('Failed to parse response from Broker.'));
          }
        }
      });

      socket.on('error', (err) => {
        reject(err);
      });
    });
  }
}

// If run directly, run an example task enqueue
if (require.main === module) {
  const client = new QueueClient();
  
  // Submit a mix of test tasks
  Promise.all([
    client.enqueue('heavy_computation', { iterations: 10000000 }, { retries: 2 }),
    client.enqueue('flaky_task', { failRate: 0.6 }, { retries: 3, delay: 1000 }),
    client.enqueue('heavy_computation', { iterations: 1000000 }, { delay: 4000 }) // Scheduled task
  ]).then((responses) => {
    console.log('[Producer Client] Tasks successfully submitted:');
    console.log(responses);
    process.exit(0);
  }).catch((err) => {
    console.error('[Producer Client] Error enqueuing tasks:', err.message);
    process.exit(1);
  });
}

module.exports = QueueClient;
