/**
 * Cluster Dashboard UI - Auto-loaded sidebar
 */
(function() {
    var initialized = false;

    function initClusterDashboard() {
        if (initialized) return;
        if (typeof RED === 'undefined' || !RED.sidebar) return;

        initialized = true;

        // Add sidebar tab
        RED.sidebar.addTab({
            id: 'cluster-status',
            label: 'Cluster',
            name: 'Cluster Status',
            content: $('#cluster-status-panel'),
            closeable: true,
            visible: false,
            iconClass: 'fa fa-tachometer',
            onchange: function() {
                // Tab activated
            }
        });

        // Start polling for worker status
        startWorkerStatusPolling();

        console.log('[Cluster Dashboard] Sidebar tab registered');
    }

    var workerPollInterval;

    function startWorkerStatusPolling() {
        // Initial fetch
        fetchWorkerStatus();

        // Poll every 2 seconds
        workerPollInterval = setInterval(fetchWorkerStatus, 2000);
    }

    function fetchWorkerStatus() {
        $.ajax({
            url: 'cluster/api/workers',
            type: 'GET',
            success: function(data) {
                updateWorkerTable(data);
            },
            error: function(xhr, status, error) {
                console.error('Failed to fetch worker status:', error);
                showError('Failed to fetch worker status: ' + error);
            }
        });
    }

    function updateWorkerTable(data) {
        var tbody = $('#cluster-workers-tbody');
        tbody.empty();

        if (!data.workers || data.workers.length === 0) {
            tbody.append('<tr><td colspan="6" style="text-align: center; color: #999;">No workers found</td></tr>');
            $('#cluster-summary').html('<strong>Total:</strong> 0 | <strong>Online:</strong> 0');
            return;
        }

        data.workers.forEach(function(worker) {
            var statusBadge = worker.isOnline
                ? '<span style="color: #5cb85c;">● Online</span>'
                : '<span style="color: #d9534f;">● Offline</span>';

            var lastSeen = worker.isOnline
                ? formatDuration(worker.lastSeenMs)
                : 'Offline';

            var row = $('<tr>');
            row.append($('<td>').text(worker.workerId));
            row.append($('<td>').html(statusBadge));
            row.append($('<td>').text(worker.uptimeFormatted));
            row.append($('<td>').text(lastSeen));
            row.append($('<td>').text(worker.packages || 0));
            row.append($('<td>').text(worker.nodeVersion || 'N/A'));

            tbody.append(row);
        });

        $('#cluster-summary').html(
            '<strong>Total:</strong> ' + data.totalWorkers + ' | ' +
            '<strong>Online:</strong> ' + data.onlineWorkers
        );
    }

    function formatDuration(ms) {
        if (ms < 1000) {
            return 'Just now';
        } else if (ms < 60000) {
            return Math.floor(ms / 1000) + 's ago';
        } else {
            return Math.floor(ms / 60000) + 'm ago';
        }
    }

    function showError(message) {
        var tbody = $('#cluster-workers-tbody');
        tbody.empty();
        tbody.append('<tr><td colspan="6" style="text-align: center; color: #d9534f;">' + message + '</td></tr>');
    }

    // Initialize when document is ready
    $(document).ready(function() {
        // Wait for RED to be fully initialized
        var checkRED = setInterval(function() {
            if (typeof RED !== 'undefined' && RED.sidebar) {
                clearInterval(checkRED);
                initClusterDashboard();
            }
        }, 100);
    });

    // Cleanup on page unload
    $(window).on('beforeunload', function() {
        if (workerPollInterval) {
            clearInterval(workerPollInterval);
        }
    });
})();
