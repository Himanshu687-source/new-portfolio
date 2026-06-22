let socket = null;
let reconnectTimer = null;

function connect() {
  const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${wsProtocol}//${window.location.host}`;
  console.log(`Connecting to WebSocket broker dashboard at ${wsUrl}`);

  socket = new WebSocket(wsUrl);

  socket.onopen = () => {
    console.log('WebSocket connection established.');
    const badge = document.getElementById('connection-badge');
    badge.className = 'connection-status online';
    badge.querySelector('.status-text').textContent = 'Live Connected';
    clearTimeout(reconnectTimer);
  };

  socket.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      if (data.type === 'STATS_UPDATE') {
        updateDashboard(data.stats, data.workers, data.recentJobs);
      }
    } catch (e) {
      console.error('Error handling WebSocket message:', e);
    }
  };

  socket.onclose = () => {
    console.log('WebSocket connection closed. Reconnecting in 3s...');
    const badge = document.getElementById('connection-badge');
    badge.className = 'connection-status offline';
    badge.querySelector('.status-text').textContent = 'Disconnected';
    
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connect, 3000);
  };

  socket.onerror = (error) => {
    console.error('WebSocket error:', error);
  };
}

function triggerTask(taskType) {
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({
      type: 'TRIGGER_TEST',
      task: taskType
    }));
  } else {
    alert('Dashboard is offline. Please start broker.js.');
  }
}

function updateDashboard(stats, workers, recentJobs) {
  // Update stats counters
  document.getElementById('stat-pending').textContent = stats.pending || 0;
  document.getElementById('stat-scheduled').textContent = stats.scheduled || 0;
  document.getElementById('stat-running').textContent = stats.running || 0;
  document.getElementById('stat-completed').textContent = stats.completed || 0;
  document.getElementById('stat-failed').textContent = stats.failed || 0;

  // Update workers list
  const workersList = document.getElementById('workers-list');
  document.getElementById('worker-count').textContent = workers.length;
  
  if (workers.length === 0) {
    workersList.innerHTML = `
      <div class="empty-state">No workers connected to broker. Run node worker.js in your terminal.</div>
    `;
  } else {
    workersList.innerHTML = workers.map(w => {
      const loadPercentage = Math.min(100, Math.round((w.active_jobs / w.concurrency) * 100));
      const onlineClass = w.online ? 'online' : 'offline';
      const onlineText = w.online ? 'ONLINE' : 'STALE';
      
      return `
        <div class="worker-item">
          <div class="worker-info">
            <h3>${w.id}</h3>
            <div class="worker-threads">
              Load: ${w.active_jobs} / ${w.concurrency} threads active
            </div>
            <div class="worker-load-bar">
              <div class="worker-load-fill" style="width: ${loadPercentage}%; background-color: ${loadPercentage > 80 ? 'var(--danger)' : loadPercentage > 40 ? 'var(--warning)' : 'var(--success)'}"></div>
            </div>
          </div>
          <span class="worker-status-badge ${onlineClass}">${onlineText}</span>
        </div>
      `;
    }).join('');
  }

  // Update jobs table
  const jobsTableBody = document.getElementById('jobs-table-body');
  if (recentJobs.length === 0) {
    jobsTableBody.innerHTML = `
      <tr>
        <td colspan="6" class="empty-state">No task logs found in SQLite database sync.</td>
      </tr>
    `;
  } else {
    jobsTableBody.innerHTML = recentJobs.map(j => {
      const timeStr = new Date(j.created_at).toLocaleTimeString();
      let statusBadgeClass = `badge ${j.status}`;
      
      let detailsContent = '';
      if (j.status === 'failed') {
        detailsContent = `<div class="details-wrapper details-error" title="${j.error}">${j.error}</div>`;
      } else if (j.status === 'completed') {
        const resultVal = j.result ? JSON.parse(j.result) : null;
        const msg = resultVal?.message || JSON.stringify(resultVal) || 'Success';
        detailsContent = `<div class="details-wrapper" title="${msg}">${msg}</div>`;
      } else if (j.status === 'scheduled') {
        const remaining = Math.max(0, Math.round((j.run_at - Date.now()) / 1000));
        detailsContent = `<div class="details-wrapper">Executes in ${remaining}s</div>`;
      } else if (j.status === 'running') {
        detailsContent = `<div class="details-wrapper">Executing on worker ${j.worker_id}</div>`;
      } else {
        detailsContent = `<div class="details-wrapper">Waiting in SQLite queue...</div>`;
      }

      return `
        <tr>
          <td class="job-id-cell">${j.id}</td>
          <td class="job-name-cell">${j.name}</td>
          <td><span class="${statusBadgeClass}">${j.status}</span></td>
          <td class="retries-cell">${j.retries} / ${j.max_retries}</td>
          <td class="time-cell">${timeStr}</td>
          <td class="details-cell">${detailsContent}</td>
        </tr>
      `;
    }).join('');
  }
}

// Start polling timer to refresh scheduled countdown values
setInterval(() => {
  // Simple trigger to force recalculating scheduled times if they exist
  const scheduledRows = document.querySelectorAll('.badge.scheduled');
  if (scheduledRows.length > 0) {
    // If there are scheduled tasks visible, we let the dashboard refresh values
  }
}, 1000);

// Initialize
connect();
