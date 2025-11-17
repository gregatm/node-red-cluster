/**
 * Cluster Dashboard Plugin
 * Auto-loads the cluster status sidebar panel
 */
module.exports = function(RED) {
    RED.plugins.registerPlugin('node-red-cluster-dashboard', {
        type: 'node-red-theme',
        scripts: [
            'nodes/cluster-dashboard-ui.js'
        ]
    });
};
