# node-red-cluster

Complete clustering solution for Node-RED using Valkey/Redis. This package combines storage, context, and leader election into a single unified solution for horizontal scaling.

> **Note:** This package merges and replaces my three previous packages:
> - [node-red-storage-valkey](https://github.com/Siphion/node-red-storage-valkey) (deprecated)
> - [node-red-context-valkey](https://github.com/Siphion/node-red-context-valkey) (deprecated)
> - [node-red-contrib-cluster-leader](https://github.com/Siphion/node-red-contrib-cluster-leader) (deprecated)
>
> All functionality from these packages is now available in this unified package.

## 🚀 Features

### Storage Module
- ✅ **Admin/Worker Architecture** - Separate roles for editor and execution
- ✅ **Pub/Sub Hot-Reload** - Workers automatically reload flows when admin saves
- ✅ **Package Sync** - Auto-sync Node-RED plugins from Admin to Workers
- ✅ **Debug Forwarding** - Worker debug messages appear in Admin UI debug sidebar
- ✅ **Cluster Info in Functions** - Access `cluster.type` and `cluster.workerId` directly in function nodes

### Context Store
- ✅ **Shared Context** - Global, flow, and node context shared across all instances
- ✅ **Atomic Operations** - Lua scripts for nested property updates
- ✅ **Compression** - Optional gzip for large context values (>1KB)

### Cluster Leader Nodes
- ✅ **Leader Election** - Distributed consensus for scheduled jobs (sticky leadership)
- ✅ **Automatic Failover** - TTL-based leadership with heartbeat renewal
- ✅ **Manual Release** - Release leadership lock for graceful shutdown or rebalancing
- ✅ **Multiple Leaders** - Different lock keys for different job types
- ✅ **Visual Status** - Real-time leader/follower indicators

### Cluster Monitoring
- ✅ **Unique Worker IDs** - Each worker gets a hostname-based sequential ID (e.g., `worker-1`, `worker-2`)
- ✅ **Heartbeat System** - Workers maintain presence in Redis with automatic TTL renewal
- ✅ **Graceful Shutdown** - Workers clean up their Redis keys on exit
- ✅ **Active Workers List** - Query active workers across the cluster

### Platform Support
- ✅ **Valkey/Redis Compatible** - Works with both Valkey ≥8.0 and Redis ≥6.0
- ✅ **Redis Sentinel** - High availability with automatic failover
- ✅ **Docker/K8s Ready** - Perfect for container orchestration

## 📦 Installation

```bash
npm install node-red-cluster
```

## ⚙️ Configuration

### Complete Example (Admin Node)

```javascript
// settings.js
module.exports = {
  // Storage Module
  storageModule: require('node-red-cluster/storage'),

  // Context Store
  contextStorage: {
    default: {
      module: require('node-red-cluster/context')
    }
  },

  // Unified Valkey Configuration
  valkey: {
    // Connection (shared by storage, context, and cluster leader)
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT) || 6379,
    password: process.env.REDIS_PASSWORD,
    keyPrefix: 'nodered:',

    // Storage Module Settings (Admin)
    role: 'admin',  // REQUIRED: 'admin' or 'worker'
    updateChannel: 'nodered:flows:updated',     // Channel for flow updates (default)
    syncPackages: true,                          // Sync packages to workers (default: true)
    packageChannel: 'nodered:packages:updated',  // Channel for package updates (default, optional)
    debugChannel: 'nodered:debug',               // Channel for debug forwarding (default, optional)

    // Cluster Monitoring (optional)
    clusterMonitoring: {
      enabled: true,           // Enable cluster monitoring (default: true)
      heartbeatInterval: 10000, // Heartbeat interval in ms (default: 10s)
      heartbeatTTL: 30000      // Heartbeat TTL in ms (default: 30s)
    }

    // Context & Compression
    enableCompression: true,  // Compress flows/context >1KB
    timeout: 5000,            // Context operation timeout (ms)

    // Sessions
    sessionTTL: 86400  // Session TTL in seconds (24 hours)
  },

  uiPort: 1880,
  httpAdminRoot: '/admin',  // Admin UI at http://localhost:1880/admin
  httpNodeRoot: '/api'      // API endpoints at http://localhost:1880/api
};
```

### Worker Node Configuration

```javascript
// settings.js
module.exports = {
  storageModule: require('node-red-cluster/storage'),

  contextStorage: {
    default: {
      module: require('node-red-cluster/context')
    }
  },

  valkey: {
    // Connection (same as admin)
    host: process.env.REDIS_HOST || 'redis',
    port: parseInt(process.env.REDIS_PORT) || 6379,
    password: process.env.REDIS_PASSWORD,
    keyPrefix: 'nodered:',

    // Storage Module Settings (Worker)
    role: 'worker',                         // REQUIRED: Set as worker
    updateChannel: 'nodered:flows:updated', // Subscribe to flow updates (default, auto-reload)
    // packageChannel: 'nodered:packages:updated', // Optional: only needed if admin uses custom channel

    // Context & Compression
    enableCompression: true,  // Should match admin setting
    timeout: 5000             // Context operation timeout (ms)
  },

  uiPort: 1880,
  httpAdminRoot: false,  // Disable editor on workers
  httpNodeRoot: '/api'   // API endpoints at http://worker:1880/api
};
```

### Redis Sentinel Configuration

```javascript
valkey: {
  role: 'admin',
  keyPrefix: 'nodered:',
  sentinels: [
    { host: 'sentinel1', port: 26379 },
    { host: 'sentinel2', port: 26379 },
    { host: 'sentinel3', port: 26379 }
  ],
  name: 'mymaster',
  password: process.env.REDIS_PASSWORD,
  enableCompression: true
}
```

## 🎯 Usage

### 1. Storage Module (Automatic)

The storage module works automatically once configured. Admin nodes can edit flows, worker nodes execute them.

**Admin capabilities:**
- Full flow editor
- Install/manage packages
- Save flows (triggers worker reload via pub/sub)

**Worker capabilities:**
- Execute flows only (no editor)
- Auto-reload when admin saves
- Sync packages from admin

### 2. Context Store (Automatic)

Context is automatically stored in Redis/Valkey and shared across all instances.

**⚠️ IMPORTANT: Redis context operations are ASYNCHRONOUS - you MUST use callbacks:**

```javascript
// ❌ WRONG - Synchronous calls don't work with Redis
global.set('userCount', 42);
const count = global.get('userCount');  // Returns undefined!

// ✅ CORRECT - Use callbacks for async operations
global.get('userCount', function(err, count) {
    if (err) {
        node.error(err);
        return;
    }

    if (!count) {
        // First time, set to 1
        global.set('userCount', 1, function(err) {
            if (err) node.error(err);
        });
    } else {
        // Increment
        global.set('userCount', count + 1, function(err) {
            if (err) node.error(err);
        });
    }
});
```

**Context Scope Examples:**

```javascript
// Global context (shared across ALL instances and flows)
global.get('key', function(err, value) {
    // Use value...
});

// Flow context (shared across all instances of the same flow)
flow.get('temperature', function(err, value) {
    // Use value...
});

// Node context (shared for the same node ID across instances)
context.get('counter', function(err, value) {
    // Use value...
});
```

**Why callbacks?** Redis is a network service - all operations are asynchronous. Node.js cannot block the thread waiting for network responses. This is a fundamental limitation of JavaScript/Node.js, not this package.

### 3. Cluster Leader Node (Visual)

Use the `cluster-leader` node in your flows to ensure scheduled jobs run only once:

```
                                ┌─ Output 1 (leader) ──→ [Execute Job]
                                │
[Inject: Every 5 min] → [Cluster Leader]
                                │
                                └─ Output 2 (follower) ─→ [Debug Log]
```

**⚠️ IMPORTANT: How Leadership Works**

The `cluster-leader` node implements **sticky leadership** with distributed locking:

1. **Lock Acquisition**: The first instance to receive a message acquires the lock and becomes the leader
2. **Sticky Leadership**: Once acquired, **the same instance remains the leader** for all subsequent messages
3. **Leader Persistence**: The leader keeps the lock indefinitely through automatic heartbeat renewal (every 2 seconds)
4. **Single Executor**: Only the leader instance executes the flow connected to Output 1 - all other instances send messages to Output 2 (follower)
5. **Automatic Failover**: If the leader crashes or loses connection, the lock expires after the TTL (default 10 seconds) and another instance can become the new leader
6. **Manual Release**: Use the `release-cluster-leader` node to manually release the lock and trigger a leadership change

**Example Scenario:**
- Worker-1, Worker-2, Worker-3 all receive a scheduled message every 5 minutes
- Worker-1 acquires the lock and becomes leader
- **Worker-1 executes the job** (Output 1)
- Worker-2 and Worker-3 log as followers (Output 2)
- **Worker-1 remains the leader** for ALL future executions until it crashes or the lock is manually released
- If Worker-1 crashes, after 10 seconds Worker-2 or Worker-3 becomes the new leader

**Configuration:**
- **Lock Key**: `nodered:leader` (different keys = different leaders)
- **Lock TTL**: `10` seconds (automatic failover time if leader crashes)
- **Valkey Server**: Optional config node or env vars

**Example Flow:**

```json
[
  {
    "id": "inject1",
    "type": "inject",
    "repeat": "300",
    "name": "Every 5 Minutes",
    "wires": [["leader1"]]
  },
  {
    "id": "leader1",
    "type": "cluster-leader",
    "lockKey": "nodered:backup-job",
    "lockTTL": 10,
    "wires": [["execute"], ["log"]]
  },
  {
    "id": "execute",
    "type": "http request",
    "method": "POST",
    "url": "http://api/backup",
    "name": "Run Backup",
    "wires": [[]]
  },
  {
    "id": "log",
    "type": "debug",
    "name": "Follower Log"
  }
]
```

**Message Properties:**

Leader output (port 1):
```javascript
{
  isLeader: true,
  leaderHost: "worker-1",
  ...originalMessage
}
```

Follower output (port 2):
```javascript
{
  isLeader: false,
  leaderHost: "worker-1",
  followerHost: "worker-2",
  ...originalMessage
}
```

**Status Indicators:**
- 🟢 Green dot: This instance is the leader
- 🟡 Yellow ring: This instance is a follower
- ⚫ Grey ring: No current leader
- 🔴 Red ring: Connection error

### 4. Release Cluster Leader Node

Use the `release-cluster-leader` node to manually release the leadership lock:

```
[Inject] → [Release Leader] → [Debug]
```

**When to use:**
- **Graceful Shutdown**: Release leadership before shutting down a worker for maintenance
- **Manual Failover**: Force a leadership change without waiting for the leader to crash
- **Rebalancing**: Redistribute leadership across workers
- **Testing**: Simulate failover scenarios in development

**How it works:**
1. Only the **current leader** can release its own lock
2. After release, the next message will trigger a new leader election
3. The lock is deleted from Redis immediately
4. If a non-leader tries to release, nothing happens (warning logged)

**Output Message Properties:**
```javascript
{
  lockReleased: true,        // true if lock was released
  releasedBy: "worker-1",   // hostname that released the lock
  lockKey: "nodered:leader" // the lock key that was released
}
```

**Example Flow: Graceful Shutdown**
```
[HTTP Endpoint: /shutdown] → [Release Leader] → [HTTP Response: "Lock released"]
                                  ↓
                            [Exec: shutdown -h now]
```

**Configuration:**
- **Lock Key**: Must match the lock key of the `cluster-leader` node
- **Valkey Server**: Optional config node or env vars

**Status Indicators:**
- 🟢 Green dot: Lock successfully released
- 🟡 Yellow ring: Another node is the leader
- ⚫ Grey ring: No lock exists
- 🔴 Red ring: Connection error

### Advanced: Multiple Leader Groups

Distribute leadership for different jobs across your cluster:

```javascript
// Job A - Database Backup (Worker 1 becomes leader)
lockKey: "nodered:backup-job"

// Job B - API Sync (Worker 2 becomes leader)
lockKey: "nodered:sync-job"

// Job C - Report Generation (Worker 3 becomes leader)
lockKey: "nodered:report-job"
```

This ensures different workers handle different scheduled tasks, distributing the load.

### 5. Debug Message Forwarding (Automatic)

Debug messages from worker nodes are automatically forwarded to the admin node and appear in the debug sidebar with the worker ID prefix.

**How it works:**
1. **Worker nodes** capture debug node outputs and `node.warn()`/`node.error()` calls
2. Messages are forwarded to Redis pub/sub channel (`nodered:debug`)
3. **Admin node** receives messages and injects them into the debug sidebar
4. Each message is prefixed with the worker ID for easy identification

**Example debug output:**
```
[worker-1] Temperature: 25.3°C
[worker-2] Sensor offline
[worker-1] [warn] High CPU usage
```

**Configuration:**
- **Debug Channel**: `nodered:debug` (default, can be customized)
- **Worker ID Format**: `hostname-N` (e.g., `nodered-worker-1`, `worker-2`)
- **Automatic**: No configuration needed, works out of the box

**Supported message types:**
- Debug node outputs
- `node.warn()` messages
- `node.error()` messages

This feature makes it easy to monitor and debug worker nodes directly from the admin UI without checking individual worker logs.

### 6. Cluster Information in Function Nodes

The `cluster` object is automatically available in all function nodes, providing instance-specific metadata:

```javascript
// Direct access to cluster information (no imports needed)
msg.payload = cluster.type;       // 'admin' or 'worker'
msg.payload = cluster.workerId;   // 'worker-1', 'worker-2', etc.

// Conditional logic based on node type
if (cluster.type === 'worker') {
    msg.payload = `Processed by ${cluster.workerId}`;
    return msg;
}

// Route messages differently on admin vs worker
if (cluster.type === 'admin') {
    node.warn('This flow should only run on workers');
    return null;
}

return msg;
```

**Properties:**

| Property | Type | Description |
|----------|------|-------------|
| `cluster.type` | `'admin' \| 'worker'` | Node role (matches `valkey.role` config) |
| `cluster.workerId` | `string` | Unique worker ID (e.g., `worker-1`, `worker-2`) or `null` for admin |

**Important Notes:**
- No imports or setup needed in function nodes
- Full definitions for editor autocomplete
- Values are instance-specific and local to each Node-RED
- Available since package version 2.1.0

### 7. Cluster Monitoring (Automatic)

The cluster monitoring system tracks all active workers and assigns them unique sequential IDs.

**Worker ID Assignment:**
- Each worker gets a unique ID based on hostname and sequence number
- Format: `hostname-N` where N is the first available number (1, 2, 3, ...)
- Example: `worker-1`, `worker-2`, `worker-3` or `pod-abc-1`, `pod-abc-2`

**Heartbeat System:**
- Workers send heartbeat every 10 seconds (configurable)
- Heartbeat TTL is 30 seconds (configurable)
- If a worker crashes, its Redis key expires after TTL
- Other workers can reuse the worker ID after expiration

**Graceful Shutdown:**
- Workers automatically clean up their Redis keys on shutdown (SIGTERM, SIGINT)
- Leadership locks are released
- Clean cluster state maintained

**Monitoring Configuration:**
```javascript
valkey: {
  clusterMonitoring: {
    enabled: true,           // Enable monitoring (default: true)
    heartbeatInterval: 10000, // Heartbeat every 10s
    heartbeatTTL: 30000      // Expire after 30s if no heartbeat
  }
}
```

**Query Active Workers:**
```javascript
// Get list of active workers (admin node only)
const storage = RED.settings.storageModule;
const clusterMonitor = storage.getClusterMonitor();
const activeWorkers = await clusterMonitor.getActiveWorkers();

// Returns array of worker info:
// [
//   {
//     workerId: 'worker-1',
//     hostname: 'worker',
//     n: 1,
//     role: 'worker',
//     pid: 1234,
//     nodeVersion: 'v18.19.0',
//     startTime: 1234567890,
//     lastHeartbeat: 1234567900,
//     uptime: 10000
//   },
//   ...
// ]
```

**Admin nodes:**
- Admin nodes are NOT tracked in cluster monitoring
- Admin ID format: `hostname-admin` (for logging purposes only)
- No heartbeat or Redis key for admin nodes

## 🏗️ Architecture

### How It Works

```
┌─────────────────────────────────────────────────────────────────────┐
│                         Redis/Valkey                                │
│  ┌─────────────┬──────────────┬──────────────┬─────────────────┐    │
│  │   Storage   │   Context    │ Leader Locks │ Cluster Monitor │    │
│  │  flows      │  global:*    │  leader      │  worker:worker-1│    │
│  │  credentials│  flow:*      │  backup-job  │  worker:worker-2│    │
│  │  settings   │  node:*      │  ...         │  ...            │    │
│  └─────────────┴──────────────┴──────────────┴─────────────────┘    │
│         ↑              ↑              ↑               ↑             │
│    Pub/Sub         Atomic Ops    SET NX EX      Heartbeat+TTL       │
│  (flows, debug)                                                     │
└─────────┬──────────────┬─────────────┬──────────────┬───────────────┘
          │              │             │              │
     ┌────┴────┐    ┌────┴────┐   ┌────┴────┐    ┌────┴────┐
     │ Admin   │    │ Worker 1│   │ Worker 2│    │ Worker 3│
     │         │    │         │   │         │    │         │
     │ Editor  │    │ Execute │   │ Execute │    │ Execute │
     │ Execute │    │ Debug TX│   │ Debug TX│    │ Debug TX│
     │ Debug RX│    │ Auto-   │   │ Auto-   │    │ Auto-   │
     │ Publish │    │ Reload  │   │ Reload  │    │ Reload  │
     │ Flows   │    │ Leader  │   │ Follower│    │ Follower│
     │ ID:admin│    │ ID: w-1 │   │ ID: w-2 │    │ ID: w-3 │
     └─────────┘    └─────────┘   └─────────┘    └─────────┘
```

### Key Features

1. **Storage Sync**: Admin saves → Redis pub/sub → Workers reload
2. **Shared Context**: All instances read/write to same Redis keys
3. **Leader Election**: Only one worker executes scheduled jobs
4. **Package Sync**: Admin installs package → Workers auto-sync
5. **Debug Forwarding**: Worker debug → Redis pub/sub → Admin UI
6. **Cluster Monitoring**: Workers register with unique IDs + heartbeat

### Redis Key Structure

```
# Storage
nodered:flows                    # Flow configuration
nodered:credentials              # Encrypted credentials
nodered:settings                 # User settings
nodered:sessions                 # User sessions (with TTL)
nodered:packages                 # Installed packages list

# Context Store
nodered:context:global:*         # Global context
nodered:context:flow:*           # Flow context
nodered:context:node:*           # Node context

# Leader Election
nodered:leader                   # Default leader lock
nodered:backup-job               # Job-specific leader lock
nodered:sync-job                 # Another job-specific lock

# Cluster Monitoring
nodered:cluster:worker:worker-1  # Worker 1 info + heartbeat (TTL: 30s)
nodered:cluster:worker:worker-2  # Worker 2 info + heartbeat (TTL: 30s)
nodered:cluster:worker:worker-3  # Worker 3 info + heartbeat (TTL: 30s)

# Pub/Sub Channels
nodered:flows:updated            # Flow update notifications
nodered:packages:updated         # Package sync notifications
nodered:debug                    # Debug message forwarding
```

## 🐳 Docker Deployment

### Docker Compose with Swarm Mode

```yaml
version: '3.8'

services:
  redis:
    image: valkey/valkey:8.0
    ports:
      - "6379:6379"
    volumes:
      - redis-data:/data
    deploy:
      replicas: 1
      placement:
        constraints:
          - node.role == manager

  nodered-admin:
    image: nodered/node-red:latest
    ports:
      - "1880:1880"
    environment:
      - REDIS_HOST=redis
      - REDIS_PORT=6379
      - NODE_RED_ROLE=admin
    volumes:
      - admin-data:/data                      # Persistent admin data
      - ./settings-admin.js:/data/settings.js:ro
    depends_on:
      - redis
    deploy:
      replicas: 1
      placement:
        constraints:
          - node.role == manager

  nodered-worker:
    image: nodered/node-red:latest
    environment:
      - REDIS_HOST=redis
      - REDIS_PORT=6379
      - NODE_RED_ROLE=worker
    volumes:
      - ./settings-worker.js:/data/settings.js:ro
    depends_on:
      - redis
    deploy:
      replicas: 3  # Scale workers horizontally
      restart_policy:
        condition: any
        delay: 5s
        max_attempts: 3
      update_config:
        parallelism: 1
        delay: 10s
      rollback_config:
        parallelism: 1
        delay: 10s

volumes:
  redis-data:
  admin-data:  # Persistent volume for admin
```

**Deploy to Docker Swarm:**
```bash
docker stack deploy -c docker-compose.yml nodered-cluster
```

**Scale workers:**
```bash
docker service scale nodered-cluster_nodered-worker=5
```

### Kubernetes Deployment

Create the settings files (see `settings-admin.js` and `settings-worker.js` above), then:

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: nodered-settings
data:
  settings-admin.js: |-
    # Copy content from settings-admin.js
  settings-worker.js: |-
    # Copy content from settings-worker.js
---
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: nodered-admin-data
spec:
  accessModes:
    - ReadWriteOnce
  resources:
    requests:
      storage: 10Gi
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: nodered-admin
spec:
  replicas: 1
  selector:
    matchLabels:
      app: nodered-admin
  template:
    metadata:
      labels:
        app: nodered-admin
    spec:
      containers:
      - name: nodered
        image: nodered/node-red:latest
        ports:
        - containerPort: 1880
        env:
        - name: REDIS_HOST
          value: "redis"
        - name: REDIS_PORT
          value: "6379"
        volumeMounts:
        - name: admin-data
          mountPath: /data
        - name: settings
          mountPath: /data/settings.js
          subPath: settings-admin.js
      volumes:
      - name: admin-data
        persistentVolumeClaim:
          claimName: nodered-admin-data
      - name: settings
        configMap:
          name: nodered-settings
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: nodered-worker
spec:
  replicas: 3  # Scale workers horizontally
  selector:
    matchLabels:
      app: nodered-worker
  template:
    metadata:
      labels:
        app: nodered-worker
    spec:
      containers:
      - name: nodered
        image: nodered/node-red:latest
        env:
        - name: REDIS_HOST
          value: "redis"
        - name: REDIS_PORT
          value: "6379"
        volumeMounts:
        - name: settings
          mountPath: /data/settings.js
          subPath: settings-worker.js
      volumes:
      - name: settings
        configMap:
          name: nodered-settings
---
apiVersion: v1
kind: Service
metadata:
  name: nodered-admin
spec:
  type: LoadBalancer
  ports:
  - port: 1880
    targetPort: 1880
  selector:
    app: nodered-admin
---
apiVersion: v1
kind: Service
metadata:
  name: nodered-worker
spec:
  type: ClusterIP
  ports:
  - port: 1880
    targetPort: 1880
  selector:
    app: nodered-worker
```

**Deploy to Kubernetes:**
```bash
kubectl apply -f nodered-cluster.yaml
```

**Scale workers:**
```bash
kubectl scale deployment nodered-worker --replicas=5
```

### settings-admin.js

```javascript
module.exports = {
  storageModule: require('node-red-cluster/storage'),

  contextStorage: {
    default: {
      module: require('node-red-cluster/context')
    }
  },

  valkey: {
    host: process.env.REDIS_HOST,
    port: parseInt(process.env.REDIS_PORT),
    keyPrefix: 'nodered:',
    role: 'admin',
    enableCompression: true,
    syncPackages: true
  },

  uiPort: 1880,
  httpAdminRoot: '/admin',  // Admin UI at /admin
  httpNodeRoot: '/api'
};
```

### settings-worker.js

```javascript
module.exports = {
  storageModule: require('node-red-cluster/storage'),

  contextStorage: {
    default: {
      module: require('node-red-cluster/context')
    }
  },

  valkey: {
    host: process.env.REDIS_HOST,
    port: parseInt(process.env.REDIS_PORT),
    keyPrefix: 'nodered:',
    role: 'worker',
    enableCompression: true
  },

  uiPort: 1880,
  httpAdminRoot: false,  // Disable editor
  httpNodeRoot: '/api'
};
```

## 🔧 Configuration Reference

### Storage Module Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `role` | `'admin' \| 'worker'` | **required** | Node role (admin or worker) |
| `keyPrefix` | `string` | `'nodered:'` | Redis key prefix |
| `updateChannel` | `string` | `'nodered:flows:updated'` | Pub/sub channel for flow updates |
| `enableCompression` | `boolean` | `false` | Compress flows/credentials >1KB |
| `sessionTTL` | `number` | `86400` | Session TTL in seconds |
| `syncPackages` | `boolean` | `true` | *(Admin only)* Enable package sync to workers |
| `packageChannel` | `string` | `'nodered:packages:updated'` | Pub/sub channel for package updates |
| `debugChannel` | `string` | `'nodered:debug'` | Pub/sub channel for debug message forwarding |
| `clusterMonitoring` | `object` | See below | Cluster monitoring configuration |

**Cluster Monitoring Options:**

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `enabled` | `boolean` | `true` | Enable cluster monitoring |
| `heartbeatInterval` | `number` | `10000` | Heartbeat interval in milliseconds (10s) |
| `heartbeatTTL` | `number` | `30000` | Heartbeat TTL in milliseconds (30s) |

**Note:** Both admin and worker use the default `packageChannel` and `debugChannel` values. Only specify them explicitly if you need custom channel names (must be the same on both admin and worker).

### Context Store Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `keyPrefix` | `string` | `'nodered:'` | Redis key prefix |
| `enableCompression` | `boolean` | `false` | Compress context >1KB |
| `timeout` | `number` | `5000` | Operation timeout (ms) |

### Cluster Leader Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `lockKey` | `string` | `'nodered:leader'` | Redis lock key |
| `lockTTL` | `number` | `10` | Lock TTL in seconds |

### Redis Connection Options

All standard `ioredis` options are supported:

```javascript
valkey: {
  // Single instance
  host: 'localhost',
  port: 6379,
  password: 'secret',
  db: 0,

  // Sentinel
  sentinels: [
    { host: 'sentinel1', port: 26379 },
    { host: 'sentinel2', port: 26379 }
  ],
  name: 'mymaster',

  // TLS
  tls: {
    ca: fs.readFileSync('ca.crt'),
    cert: fs.readFileSync('client.crt'),
    key: fs.readFileSync('client.key')
  }
}
```

## 🧪 Troubleshooting

### Workers Not Reloading

1. Check Redis pub/sub channel:
   ```bash
   redis-cli SUBSCRIBE "nodered:flows:updated"
   ```

2. Verify worker role:
   ```javascript
   valkey: { role: 'worker' }
   ```

3. Check worker logs for reload messages

### Context Not Shared

1. Verify both instances use same `keyPrefix`
2. Check Redis connection
3. Inspect Redis keys:
   ```bash
   redis-cli KEYS "nodered:context:*"
   ```

### Multiple Leaders

1. Ensure all instances use the same `lockKey`
2. Check clock synchronization (NTP)
3. Verify Redis connectivity
4. Increase `lockTTL` if network is unreliable

### All Nodes Show "Follower"

1. Check Redis connectivity
2. Verify `lockKey` is accessible
3. Check Redis logs for errors

## 🔐 Security

- Credentials are stored encrypted (Node-RED handles encryption)
- Redis password support
- TLS/SSL support
- Sentinel authentication
- Key prefix isolation

## 🤝 Contributing

This package consolidates three previous packages into one unified solution. All development now happens here.

**Previous packages (now deprecated):**
- [node-red-storage-valkey](https://github.com/Siphion/node-red-storage-valkey) → Storage module
- [node-red-context-valkey](https://github.com/Siphion/node-red-context-valkey) → Context store
- [node-red-contrib-cluster-leader](https://github.com/Siphion/node-red-contrib-cluster-leader) → Leader election node

Issues and PRs welcome on the [main repository](https://github.com/Siphion/node-red-cluster)!

## 📄 License

This project is licensed under the **Elastic License 2.0**.

### What This Means

✅ **You CAN:**
- Use this software for commercial purposes
- Modify and distribute the software
- Use it internally in your company/products
- Include it in your Node-RED based applications
- Build commercial products that use Node-RED with this plugin

❌ **You CANNOT:**
- Provide this software as a **hosted or managed service** to third parties
- Offer "Node-RED as a Service" where clustering is a core feature
- Sell "Managed Node-RED Hosting" using this package as infrastructure

### Example Scenarios

**Allowed:**
- Company uses Node-RED internally for IoT/automation with this clustering plugin ✅
- SaaS product that uses Node-RED as part of its backend infrastructure ✅
- Consulting company deploys Node-RED clusters for clients (on-premise) ✅
- Open source project using this for clustering ✅

**Not Allowed:**
- Cloud provider offering "Node-RED Hosting" as a managed service ❌
- Platform selling "Scalable Node-RED" where users access hosted Node-RED instances ❌

For full license terms, see [LICENSE](LICENSE) file.

## 🙏 Credits

- Built with [ioredis](https://github.com/redis/ioredis)
- Compatible with [Valkey](https://valkey.io) and [Redis](https://redis.io)
- Designed for [Node-RED](https://nodered.org)

---

**Made with ❤️ by [Siphion](https://github.com/Siphion)**
