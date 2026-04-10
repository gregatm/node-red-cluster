import type { Redis } from 'ioredis';
import * as os from 'os';
import type { ClusterMonitoringConfig, WorkerInfo } from './types.cjs';

const DEFAULT_HEARTBEAT_INTERVAL = 10000; // 10s
const DEFAULT_HEARTBEAT_TTL = 30000; // 30s

export class ClusterMonitor {
  private redis: Redis;
  private config: Required<ClusterMonitoringConfig>;
  private workerId: string | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private isShuttingDown = false;

  constructor(redis: Redis, config?: ClusterMonitoringConfig) {
    this.redis = redis;
    this.config = {
      enabled: config?.enabled ?? true,
      heartbeatInterval: config?.heartbeatInterval ?? DEFAULT_HEARTBEAT_INTERVAL,
      heartbeatTTL: config?.heartbeatTTL ?? DEFAULT_HEARTBEAT_TTL,
    };
  }

  /**
   * Initialize cluster monitoring:
   * - Acquire unique worker ID (hostname-N)
   * - Start heartbeat to maintain presence in Redis
   * Note: Admin nodes are not tracked in the cluster
   */
  async initialize(role: 'admin' | 'worker'): Promise<string> {
    // Skip cluster monitoring for admin nodes
    if (role === 'admin') {
      const adminId = `${os.hostname()}-admin`;
      console.log(`[ClusterMonitor] Admin node - cluster monitoring skipped`);
      return adminId;
    }

    if (!this.config.enabled) {
      const fallbackId = `${os.hostname()}-${process.pid}`;
      console.log(`[ClusterMonitor] Monitoring disabled, using fallback ID: ${fallbackId}`);
      return fallbackId;
    }

    try {
      this.workerId = await this.acquireUniqueWorkerId(role);
      console.log(`[ClusterMonitor] Acquired worker ID: ${this.workerId}`);

      this.startHeartbeat(role);
      this.setupShutdownHandlers();

      return this.workerId;
    } catch (error) {
      console.error(`[ClusterMonitor] Failed to initialize: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }
  }

  /**
   * Acquire a unique worker ID using atomic SET NX with retry loop.
   * Format: hostname-N where N is the first available counter (1, 2, 3, ...)
   */
  private async acquireUniqueWorkerId(role: 'admin' | 'worker'): Promise<string> {
    const hostname = os.hostname();
    const maxRetries = 100;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        // Find all existing workers with this hostname
        const pattern = `nodered:cluster:worker:${hostname}-*`;
        const existingKeys = await this.redis.keys(pattern);

        // Extract used numbers
        const usedNumbers = existingKeys
          .map(key => {
            const parts = key.split('-');
            const numStr = parts[parts.length - 1];
            return parseInt(numStr, 10);
          })
          .filter(n => !isNaN(n))
          .sort((a, b) => a - b);

        // Find first available N
        let n = 1;
        while (usedNumbers.includes(n)) {
          n++;
        }

        const workerId = `${hostname}-${n}`;
        const key = `nodered:cluster:worker:${workerId}`;

        // Prepare worker info
        const workerInfo: WorkerInfo = {
          workerId,
          hostname,
          n,
          role,
          pid: process.pid,
          nodeVersion: process.version,
          startTime: Date.now(),
          lastHeartbeat: Date.now(),
          uptime: 0,
        };

        // Atomic acquisition with SET NX
        const result = await this.redis.set(
          key,
          JSON.stringify(workerInfo),
          'PX', // TTL in milliseconds
          this.config.heartbeatTTL,
          'NX'  // Only set if not exists
        );

        if (result === 'OK') {
          return workerId;
        }

        // Someone else took this N, retry
        await new Promise(resolve => setTimeout(resolve, 10));
      } catch (error) {
        console.error(`[ClusterMonitor] Retry ${attempt + 1}/${maxRetries} failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    throw new Error(`Failed to acquire unique worker ID after ${maxRetries} retries`);
  }

  /**
   * Start periodic heartbeat to maintain presence in Redis
   */
  private startHeartbeat(role: 'admin' | 'worker'): void {
    if (!this.workerId) {
      throw new Error('Cannot start heartbeat without worker ID');
    }

    const key = `nodered:cluster:worker:${this.workerId}`;

    this.heartbeatTimer = setInterval(async () => {
      if (this.isShuttingDown) return;

      try {
        const data = await this.redis.get(key);

        if (!data) {
          // Key expired! Re-acquire
          console.warn(`[ClusterMonitor] Key expired, re-acquiring ID...`);
          if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer);
          }
          await this.initialize(role);
          return;
        }

        const workerInfo: WorkerInfo = JSON.parse(data);
        workerInfo.lastHeartbeat = Date.now();
        workerInfo.uptime = Date.now() - workerInfo.startTime;

        // Update with renewed TTL
        await this.redis.set(
          key,
          JSON.stringify(workerInfo),
          'PX',
          this.config.heartbeatTTL
        );
      } catch (error) {
        console.error(`[ClusterMonitor] Heartbeat failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }, this.config.heartbeatInterval);
  }

  /**
   * Setup graceful shutdown handlers to clean up Redis key
   */
  private setupShutdownHandlers(): void {
    const cleanup = async () => {
      if (this.isShuttingDown) return;
      this.isShuttingDown = true;

      console.log('[ClusterMonitor] Shutting down...');

      if (this.heartbeatTimer) {
        clearInterval(this.heartbeatTimer);
        this.heartbeatTimer = null;
      }

      if (this.workerId) {
        const key = `nodered:cluster:worker:${this.workerId}`;
        try {
          await this.redis.del(key);
          console.log(`[ClusterMonitor] Removed worker key: ${key}`);
        } catch (error) {
          console.error(`[ClusterMonitor] Failed to remove worker key: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    };

    process.on('SIGTERM', cleanup);
    process.on('SIGINT', cleanup);
    process.on('beforeExit', cleanup);
  }

  /**
   * Get list of all active workers from Redis
   */
  async getActiveWorkers(): Promise<WorkerInfo[]> {
    try {
      const keys = await this.redis.keys('nodered:cluster:worker:*');
      const workers: WorkerInfo[] = [];

      for (const key of keys) {
        const data = await this.redis.get(key);
        if (data) {
          try {
            const workerInfo: WorkerInfo = JSON.parse(data);
            workers.push(workerInfo);
          } catch (error) {
            console.error(`[ClusterMonitor] Failed to parse worker data for ${key}: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
      }

      // Sort by workerId
      return workers.sort((a, b) => a.workerId.localeCompare(b.workerId));
    } catch (error) {
      console.error(`[ClusterMonitor] Failed to get active workers: ${error instanceof Error ? error.message : String(error)}`);
      return [];
    }
  }

  /**
   * Get current worker ID
   */
  getWorkerId(): string | null {
    return this.workerId;
  }

  /**
   * Stop heartbeat and cleanup
   */
  async stop(): Promise<void> {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }

    if (this.workerId) {
      const key = `nodered:cluster:worker:${this.workerId}`;
      await this.redis.del(key);
      this.workerId = null;
    }
  }
}
