/**
 * Cluster information module for Node-RED function nodes
 * This module is automatically loaded into functionGlobalContext
 * making 'cluster' available as a direct variable in function nodes
 *
 * @module cluster-info
 */

// Singleton to store cluster information
let _clusterInfo = {
    type: 'admin',
    workerId: 'unknown'
};

/**
 * Set cluster information (called by storage plugin during init)
 * @internal
 */
function setClusterInfo(info) {
    _clusterInfo = info;
}

/**
 * Cluster information object
 * Automatically available in function nodes as 'cluster'
 */
const cluster = {
    /**
     * Get node type: 'admin' or 'worker'
     * @returns {'admin'|'worker'}
     */
    get type() {
        return _clusterInfo.type;
    },

    /**
     * Get unique worker ID for this instance (e.g., 'hostname-1')
     * @returns {string}
     */
    get workerId() {
        return _clusterInfo.workerId;
    }
};

// Export the cluster object (frozen to prevent modifications)
module.exports = Object.freeze(cluster);

// Also export setter for internal use by storage plugin
module.exports._setClusterInfo = setClusterInfo;
