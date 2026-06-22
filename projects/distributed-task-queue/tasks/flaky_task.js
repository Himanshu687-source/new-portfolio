/**
 * Flaky Task
 * Simulates a task that might fail due to network instability (e.g., API requests).
 * This demonstrates the broker's automatic retry logic and exponential backoff.
 */
module.exports = async function(data) {
  const failRate = data.failRate ?? 0.5; // Default 50% failure rate
  console.log(`[Task] Attempting flaky network call (Fail Rate: ${failRate * 100}%)...`);
  
  // Simulate delay
  await new Promise(resolve => setTimeout(resolve, 1000));
  
  const roll = Math.random();
  if (roll < failRate) {
    throw new Error(`Connection timeout: External service returned 504 Gateway Timeout (Roll: ${roll.toFixed(2)} < ${failRate})`);
  }
  
  return {
    message: 'Flaky network request succeeded!',
    roll: roll.toFixed(2),
    timestamp: Date.now()
  };
};
