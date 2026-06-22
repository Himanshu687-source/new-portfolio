/**
 * Heavy Computation Task
 * Simulates a CPU-heavy workload by calculating prime numbers.
 * This demonstrates the effectiveness of multi-threaded worker execution
 * since it runs in a worker thread and does not block the main process event loop.
 */
function isPrime(num) {
  if (num <= 1) return false;
  if (num <= 3) return true;
  if (num % 2 === 0 || num % 3 === 0) return false;
  for (let i = 5; i * i <= num; i += 6) {
    if (num % i === 0 || num % (i + 2) === 0) return false;
  }
  return true;
}

module.exports = async function(data) {
  const iterations = data.iterations || 5000000;
  console.log(`[Task] Calculating prime numbers up to ${iterations} iterations...`);
  
  let primeCount = 0;
  // Simulating heavy CPU work
  for (let i = 0; i < iterations; i++) {
    if (isPrime(i)) {
      primeCount++;
    }
  }
  
  return {
    message: 'Finished heavy prime calculations successfully.',
    iterations,
    primesFound: primeCount
  };
};
