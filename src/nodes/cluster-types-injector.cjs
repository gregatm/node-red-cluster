/**
 * Dummy node to inject cluster type definitions into Monaco editor
 * This node doesn't appear in the palette, it just loads the HTML file
 * which contains the Monaco type injection script
 */

module.exports = function(RED) {
    // Register a hidden node type just to load the HTML file
    // The HTML file contains the <script> that injects Monaco types
    function ClusterTypesInjector(config) {
        RED.nodes.createNode(this, config);
        // This node does nothing - it's just a vehicle to load the HTML
    }

    RED.nodes.registerType("cluster-types-injector", ClusterTypesInjector);
};
