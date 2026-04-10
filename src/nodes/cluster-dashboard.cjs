/**
 * Cluster Dashboard Node
 * Provides a sidebar panel showing all workers status and health
 */

module.exports = function (RED) {
  console.log('[ClusterDashboard] Module loaded, registering API endpoint and UI script...');

  // Helper to get storage - try multiple approaches
  function getStorage() {
    // Try RED.settings.storageModule first (server-side settings)
    if (RED.settings && RED.settings.storageModule) {
      return RED.settings.storageModule;
    }

    // Try getting from runtime
    if (RED.runtime && RED.runtime.storage) {
      return RED.runtime.storage;
    }

    // Last resort: try require
    try {
      return require('node-red-cluster').storageModule;
    } catch (e) {
      return null;
    }
  }

  // Serve the cluster dashboard UI script that auto-loads in the editor
  RED.httpAdmin.get('/cluster/cluster-dashboard.js', (req, res) => {
    res.type('application/javascript');
    res.send(`
(function() {
  function initClusterDashboard() {
    // Check if RED is available
    if (typeof RED === 'undefined' || !RED.sidebar) {
      console.log('[ClusterDashboard] RED not ready, will retry...');
      setTimeout(initClusterDashboard, 100);
      return;
    }

    // Check if cluster tab already exists
    if (document.getElementById('red-ui-sidebar-tab-cluster')) {
      console.log('[ClusterDashboard] Tab already exists, skipping registration');
      return;
    }

    // Create the content div
    const contentDiv = document.createElement('div');
    contentDiv.id = 'cluster-workers-panel';
    contentDiv.style.cssText = 'height: 100%; display: flex; flex-direction: column;';

    contentDiv.innerHTML = \`
      <div style="padding: 10px; border-bottom: 1px solid #ccc;">
        <h3 style="margin: 0;">Cluster Status</h3>
        <div id="cluster-stats" style="font-size: 0.9em; color: #666; margin-top: 5px;">
          Loading...
        </div>
      </div>
      <div style="flex: 1; overflow: auto; padding: 10px;">
        <table id="workers-table" style="width: 100%; border-collapse: collapse; font-size: 0.85em;">
          <thead>
            <tr style="background: #f0f0f0;">
              <th style="padding: 8px; text-align: left; border-bottom: 2px solid #ddd;">Worker ID</th>
              <th style="padding: 8px; text-align: center; border-bottom: 2px solid #ddd;">Status</th>
              <th style="padding: 8px; text-align: left; border-bottom: 2px solid #ddd;">Uptime</th>
              <th style="padding: 8px; text-align: left; border-bottom: 2px solid #ddd;">Last Seen</th>
            </tr>
          </thead>
          <tbody id="workers-tbody">
            <tr>
              <td colspan="4" style="padding: 20px; text-align: center; color: #666;">
                Loading worker data...
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    \`;

    // Add the cluster tab to the sidebar
    RED.sidebar.addTab({
      id: "cluster",
      label: "Cluster",
      name: "Cluster Workers",
      iconClass: "fa fa-server",
      content: contentDiv,
      enableOnEdit: false,
      pinned: true
    });

    console.log('[ClusterDashboard] Cluster tab registered');

    // Function to fetch and update worker status
    async function fetchWorkerStatus() {
      try {
        const response = await fetch('/admin/cluster/api/workers');
        const data = await response.json();

        // Update stats
        const statsDiv = document.getElementById('cluster-stats');
        if (statsDiv) {
          statsDiv.textContent = \`Total: \${data.totalWorkers} | Online: \${data.onlineWorkers}\`;
        }

        // Update table
        const tbody = document.getElementById('workers-tbody');
        if (!tbody) return;

        if (data.workers.length === 0) {
          tbody.innerHTML = '<tr><td colspan="4" style="padding: 20px; text-align: center; color: #999;">No workers found</td></tr>';
          return;
        }

        tbody.innerHTML = data.workers.map(worker => {
          const lastSeenText = worker.isOnline
            ? (worker.lastSeenMs < 1000 ? 'just now' : \`\${Math.floor(worker.lastSeenMs / 1000)}s ago\`)
            : 'offline';

          return \`
            <tr style="border-bottom: 1px solid #eee;">
              <td style="padding: 8px;">\${worker.workerId}</td>
              <td style="padding: 8px; text-align: center;">
                <span style="display: inline-block; width: 10px; height: 10px; border-radius: 50%; background: \${worker.isOnline ? '#5cb85c' : '#d9534f'};"></span>
              </td>
              <td style="padding: 8px;">\${worker.uptimeFormatted}</td>
              <td style="padding: 8px; color: #666;">\${lastSeenText}</td>
            </tr>
          \`;
        }).join('');
      } catch (error) {
        console.error('[ClusterDashboard] Error fetching worker status:', error);
        const statsDiv = document.getElementById('cluster-stats');
        if (statsDiv) {
          statsDiv.textContent = 'Error loading data';
        }
      }
    }

    // Initial fetch
    fetchWorkerStatus();

    // Poll every 2 seconds
    setInterval(fetchWorkerStatus, 2000);

    console.log('[ClusterDashboard] Worker status polling started');
  }

  // Start initialization immediately
  initClusterDashboard();
})();
    `);
  });

  console.log('[ClusterDashboard] UI script endpoint registered at /cluster/cluster-dashboard.js');

  // Register HTTP endpoint for worker status API (only once at module load)
  RED.httpAdmin.get('/cluster/api/workers', async (req, res) => {
    try {
      const storageModule = getStorage();

      if (!storageModule) {
        console.log('[ClusterDashboard] Storage module not found. RED.settings keys:', Object.keys(RED.settings || {}).slice(0, 10));
        console.log('[ClusterDashboard] RED.runtime exists:', !!RED.runtime);
        return res.status(503).json({ error: 'Storage module not available' });
      }

      // Get the internal storage instance
      const storage = storageModule._storageInstance;

      if (!storage) {
        console.log('[ClusterDashboard] Storage instance not available');
        return res.status(503).json({ error: 'Storage instance not available' });
      }

      // Get cluster monitor from storage
      const clusterMonitor = storage.getClusterMonitor ? storage.getClusterMonitor() : null;

      if (!clusterMonitor) {
        console.log('[ClusterDashboard] Cluster monitor not available');
        return res.status(503).json({ error: 'Cluster monitor not available' });
      }

      // Get all active workers from cluster monitor
      const activeWorkers = await clusterMonitor.getActiveWorkers();

      // Filter to show only workers (exclude admin)
      const workersOnly = activeWorkers.filter(w => w.role === 'worker');

      // Transform worker data for dashboard
      const workers = workersOnly.map(workerInfo => {
        // Calculate if worker is online (heartbeat < 30s ago)
        const lastSeenMs = Date.now() - workerInfo.lastHeartbeat;
        const isOnline = lastSeenMs < 30000; // Match heartbeat TTL

        return {
          workerId: workerInfo.workerId,
          hostname: workerInfo.hostname,
          role: workerInfo.role,
          pid: workerInfo.pid,
          nodeVersion: workerInfo.nodeVersion,
          timestamp: workerInfo.lastHeartbeat,
          uptime: workerInfo.uptime / 1000, // Convert ms to seconds
          lastSeenMs,
          isOnline,
          uptimeFormatted: formatUptime(workerInfo.uptime / 1000),
          packages: 0 // Will be added later if needed
        };
      });

      res.json({
        workers,
        timestamp: Date.now(),
        totalWorkers: workers.length,
        onlineWorkers: workers.filter(w => w.isOnline).length
      });
    } catch (error) {
      console.error('[ClusterDashboard] Error fetching worker status:', error);
      res.status(500).json({ error: error.message });
    }
  });

  console.log('[ClusterDashboard] API endpoint registered at /cluster/api/workers');

  // Node definition (optional - just for documentation)
  function ClusterDashboardNode(config) {
    RED.nodes.createNode(this, config);
    // Node doesn't need to do anything - API is registered at module level
  }

  RED.nodes.registerType('cluster-dashboard', ClusterDashboardNode);
  console.log('[ClusterDashboard] Node type registered');
};

/**
 * Format uptime in human-readable format
 */
function formatUptime(seconds) {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);

  if (days > 0) {
    return `${days}d ${hours}h ${minutes}m`;
  } else if (hours > 0) {
    return `${hours}h ${minutes}m`;
  } else if (minutes > 0) {
    return `${minutes}m ${secs}s`;
  } else {
    return `${secs}s`;
  }
}
