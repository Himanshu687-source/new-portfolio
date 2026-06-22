const { parentPort, workerData } = require('node:worker_threads');
const path = require('node:path');

async function main() {
  const { jobId, name, data } = workerData;
  
  try {
    // Resolve path of task file
    // Allowed task files should be placed inside tasks/ directory
    const taskPath = path.join(__dirname, 'tasks', `${name}.js`);
    
    // Load module
    const taskFunction = require(taskPath);
    
    if (typeof taskFunction !== 'function') {
      throw new Error(`Task '${name}' does not export a default execution function.`);
    }

    console.log(`[Thread-${jobId}] Running task: ${name}`);
    const result = await taskFunction(data);
    
    // Return success
    parentPort.postMessage({
      status: 'COMPLETED',
      result: result
    });
  } catch (error) {
    console.error(`[Thread-${jobId}] Task failed with error:`, error.message);
    parentPort.postMessage({
      status: 'FAILED',
      error: error.message || String(error)
    });
  }
}

main();
