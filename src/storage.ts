import { Redis, type RedisOptions } from 'ioredis';
import { promisify } from 'util';
import { gzip, gunzip } from 'zlib';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { PackageHelper } from './package-helper.js';
import { ClusterMonitor } from './cluster-monitor.js';
import type {
  ValkeyStorageConfig,
  NodeREDSettings,
  FlowConfig,
  CredentialsConfig,
  UserSettings,
  SessionsConfig,
  LibraryEntry,
  StorageModule,
  ProjectMetadata,
} from './types.js';

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

/**
 * Format log message with timestamp like Node-RED
 */
function log(message: string): void {
  const now = new Date();
  const day = now.getDate().toString().padStart(2, '0');
  const month = now.toLocaleString('en', { month: 'short' });
  const hours = now.getHours().toString().padStart(2, '0');
  const minutes = now.getMinutes().toString().padStart(2, '0');
  const seconds = now.getSeconds().toString().padStart(2, '0');
  console.log(`${day} ${month} ${hours}:${minutes}:${seconds} - ${message}`);
}

/**
 * Valkey/Redis storage module for Node-RED with pub/sub support
 */
export class ValkeyStorage implements StorageModule {
  public client!: Redis;
  private subscriber?: Redis;
  private config!: Required<ValkeyStorageConfig>;
  private packageHelper?: PackageHelper;
  private packageSubscriber?: Redis;
  private debugSubscriber?: Redis;
  private lastKnownPackages?: Record<string, string>;
  public localfilesystem?: any; // Public for git user sync in index.ts
  private runtime?: any; // Runtime reference for worker reload
  private packageSyncTimer?: NodeJS.Timeout; // Debounce timer for package sync
  private clusterMonitor?: ClusterMonitor; // Cluster monitoring with unique ID

  // Lazy restore flags - restore from Redis on first access (worker only)
  private needsRestore = {
    flows: true,
    credentials: true,
    settings: true,
    sessions: true,
  };

  constructor() {
    // Properties initialized in init()
  }

  /**
   * Initialize storage connection
   */
  async init(settings: NodeREDSettings, runtime?: any): Promise<void> {
    // Save runtime reference for worker reload
    this.runtime = runtime;

    const userConfig = (settings.valkey || {}) as Partial<ValkeyStorageConfig>;

    // Validate required role field
    if (!userConfig.role || (userConfig.role !== 'admin' && userConfig.role !== 'worker')) {
      throw new Error('[ClusterStorage] "role" field is required and must be either "admin" or "worker"');
    }

    // Extract storage-specific options with defaults
    const role = userConfig.role;
    const keyPrefix = userConfig.keyPrefix || 'nodered:';
    const updateChannel = userConfig.updateChannel || 'nodered:flows:updated';
    const enableCompression = userConfig.enableCompression || false;
    const sessionTTL = userConfig.sessionTTL || 86400;
    const syncPackages = userConfig.syncPackages !== false; // Default to true, can be disabled with syncPackages: false
    const packageChannel = userConfig.packageChannel || 'nodered:packages:updated';
    const debugChannel = userConfig.debugChannel || `${keyPrefix}debug`;

    // Extract ioredis connection options (everything else)
    const userConfigAny = userConfig as any;
    const ioredisOptions: RedisOptions = userConfigAny.redisOptions;

    // Store complete config
    this.config = {
      role,
      keyPrefix,
      updateChannel,
      enableCompression,
      sessionTTL,
      syncPackages,
      packageChannel,
      debugChannel,
      ...ioredisOptions,
    } as any; // Type assertion needed due to optional RedisOptions properties

    // Pass ioredis options directly - let ioredis handle its own defaults
    const connectionConfig: RedisOptions = ioredisOptions;
    const hasAdvancedConfig = ioredisOptions.sentinels;

    // Create Redis client with all ioredis options
    this.client = new Redis({
      ...connectionConfig,
      retryStrategy: (times: number) => {
        const delay = Math.min(times * 50, 2000);
        return delay;
      },
      reconnectOnError: (err: Error) => {
        const targetError = 'READONLY';
        if (err.message.includes(targetError)) {
          return true;
        }
        return false;
      },
    });

    await this.client.ping();

    // Log connection info
    const connInfo = hasAdvancedConfig
      ? 'Redis (Sentinel mode)'
      : connectionConfig.host
        ? `${connectionConfig.host}:${connectionConfig.port || 6379}`
        : 'Redis (default connection)';
    log(`[ClusterStorage] Connected to ${connInfo}`);

    // Initialize localfilesystem for both Admin and Worker nodes
    // Restore from Redis will happen lazily on first get() call
    if (settings.userDir && runtime) {
      try {
        // Dynamically resolve the localfilesystem module path
        const runtimePath = require.resolve('@node-red/runtime');
        const runtimeLibDir = require('path').dirname(runtimePath);
        const localfsPath = require('path').join(runtimeLibDir, 'storage/localfilesystem');

        this.localfilesystem = require(localfsPath);

        // Initialize localfilesystem - it will load existing files or start empty
        await this.localfilesystem.init(settings, runtime);

        log('[ClusterStorage] LocalFileSystem initialized');
      } catch (error) {
        console.error('[ClusterStorage] Failed to initialize localfilesystem:', error);
        // Non-fatal - continue without localfilesystem support
        this.localfilesystem = undefined;
      }
    } else {
      if (!settings.userDir) {
        log('[ClusterStorage] LocalFileSystem not available: settings.userDir is not set');
      } else if (!runtime) {
        log('[ClusterStorage] LocalFileSystem not available: runtime parameter is missing');
      }
    }

    // localfilesystem.init() handles creation of required files when enabled

    // Admin: Sync existing flows and credentials to Redis on startup (if not already there)
    if (this.config.role === 'admin' && this.localfilesystem) {
      try {
        // Check if flows exist in Redis
        const flowsKey = this.getKey('flows');
        const flowsExist = await this.client.exists(flowsKey);

        if (!flowsExist) {
          // Read flows from disk and sync to Redis
          const flows = await this.localfilesystem.getFlows();
          if (flows && (Array.isArray(flows) ? flows.length > 0 : Object.keys(flows).length > 0)) {
            const data = await this.serialize(flows);
            await this.client.set(flowsKey, data);
            log('[ClusterStorage] Admin: synced existing flows to Redis on startup');
          }
        }

        // Check if credentials exist in Redis
        const credsKey = this.getKey('credentials');
        const credsExist = await this.client.exists(credsKey);

        if (!credsExist) {
          // Read credentials from disk and sync to Redis (even if empty)
          const creds = await this.localfilesystem.getCredentials() || {};
          const data = await this.serialize(creds);
          await this.client.set(credsKey, data);
          log('[ClusterStorage] Admin: synced existing credentials to Redis on startup');
        }
      } catch (error) {
        console.error('[ClusterStorage] Error syncing existing data to Redis:', error);
        // Non-fatal - continue
      }
    }

    // Worker: Flows will be restored on first getFlows() call
    // We can't restore during init() because runtime is not fully initialized yet

    // Setup flow update subscription for worker nodes
    if (this.config.role === 'worker') {
      this.subscriber = this.client.duplicate();
      await this.subscriber.subscribe(this.config.updateChannel);

      this.subscriber.on('message', async (channel: string, message: string) => {
        if (channel === this.config.updateChannel) {
          log(`[ClusterStorage] Flows updated at ${message}, reloading...`);

          try {
            // Worker reads from Redis on every getFlows() call
            // Just call loadFlows() to trigger reload without process restart
            if (this.runtime && this.runtime.nodes && this.runtime.nodes.loadFlows) {
              await this.runtime.nodes.loadFlows();
              log('[ClusterStorage] Worker: flows reloaded successfully');
            } else {
              log('[ClusterStorage] Worker: runtime.nodes.loadFlows not available, restarting process');
              process.exit(0);
            }
          } catch (error: any) {
            console.error('[ClusterStorage] Worker: error reloading flows:', error.message || error);
            log('[ClusterStorage] Falling back to process restart');
            process.exit(0);
          }
        }
      });

      log(`[ClusterStorage] Subscribed to ${this.config.updateChannel}`);
    }

    // Initialize package synchronization
    if (this.config.syncPackages) {
      if (!settings.userDir) {
        throw new Error('[ClusterStorage] syncPackages requires settings.userDir to be set');
      }

      // Initialize PackageHelper
      this.packageHelper = new PackageHelper(settings.userDir);
      log(`[ClusterStorage] Package synchronization enabled, using ${settings.userDir}`);

      // Setup package subscriber for worker nodes
      if (this.config.role === 'worker') {
        this.packageSubscriber = this.client.duplicate();
        await this.packageSubscriber.subscribe(this.config.packageChannel);

        this.packageSubscriber.on('message', async (channel: string, message: string) => {
          if (channel === this.config.packageChannel) {
            try {
              log(`[ClusterStorage] Package update notification received`);

              // Parse dependencies object from admin (name -> version)
              const adminDependencies: Record<string, string> = JSON.parse(message);

              // Read worker's current package.json to get installed packages
              const packageJsonPath = path.join(this.packageHelper!.getUserDir(), 'package.json');
              let workerDependencies: Record<string, string> = {};

              try {
                const packageContent = await fs.readFile(packageJsonPath, 'utf8');
                const packageJson = JSON.parse(packageContent);
                workerDependencies = packageJson.dependencies || {};

                log(`[ClusterStorage] Worker has ${Object.keys(workerDependencies).length} packages installed`);
                log(`[ClusterStorage] Admin has ${Object.keys(adminDependencies).length} packages`);
              } catch (error) {
                log('[ClusterStorage] Worker package.json not found, assuming fresh install');
              }

              // Calculate diff
              const packagesToInstall: string[] = [];
              const packagesToUninstall: string[] = [];

              // Find packages to install or update (missing or version mismatch)
              for (const [pkg, version] of Object.entries(adminDependencies)) {
                if (!workerDependencies[pkg] || workerDependencies[pkg] !== version) {
                  // Install with specific version: package@version
                  packagesToInstall.push(`${pkg}@${version}`);
                }
              }

              // Find packages to uninstall (in worker but not in admin)
              for (const pkg of Object.keys(workerDependencies)) {
                if (!adminDependencies[pkg]) {
                  packagesToUninstall.push(pkg);
                }
              }

              log(`[ClusterStorage] Packages to install: ${packagesToInstall.length}`);
              log(`[ClusterStorage] Packages to uninstall: ${packagesToUninstall.length}`);

              // Uninstall packages first
              if (packagesToUninstall.length > 0) {
                log(`[ClusterStorage] Uninstalling packages: ${packagesToUninstall.join(', ')}`);
                await this.packageHelper!.uninstallPackages(packagesToUninstall);
                log('[ClusterStorage] Packages uninstalled, should be available to flows');
              }

              // Install new packages
              if (packagesToInstall.length > 0) {
                log(`[ClusterStorage] Installing packages: ${packagesToInstall.join(', ')}`);
                await this.packageHelper!.installPackages(packagesToInstall);
                log('[ClusterStorage] Packages installed, should be available to flows');
              }

              if (packagesToInstall.length === 0 && packagesToUninstall.length === 0) {
                log('[ClusterStorage] No package changes needed');
              }
            } catch (error) {
              console.error('[ClusterStorage] Error processing package update:', error);
              // Fail fast - exit with error code
              process.exit(1);
            }
          }
        });

        log(`[ClusterStorage] Subscribed to package updates on ${this.config.packageChannel}`);

        // Sync packages on worker startup
        try {
          log('[ClusterStorage] Worker startup: checking for package sync from Redis');

          // Try to get package list from Redis
          const packagesKey = 'nodered:packages';
          const packagesData = await this.client.get(packagesKey);

          if (packagesData) {
            const adminDependencies: Record<string, string> = JSON.parse(packagesData);
            log(`[ClusterStorage] Found ${Object.keys(adminDependencies).length} packages in Redis`);

            // Read worker's current package.json to get installed packages
            const packageJsonPath = path.join(this.packageHelper!.getUserDir(), 'package.json');
            let workerDependencies: Record<string, string> = {};

            try {
              const packageContent = await fs.readFile(packageJsonPath, 'utf8');
              const packageJson = JSON.parse(packageContent);
              workerDependencies = packageJson.dependencies || {};

              log(`[ClusterStorage] Worker has ${Object.keys(workerDependencies).length} packages installed`);
            } catch (error) {
              log('[ClusterStorage] Worker package.json not found, assuming fresh install');
            }

            // Calculate diff
            const packagesToInstall: string[] = [];
            const packagesToUninstall: string[] = [];

            // Find packages to install or update (missing or version mismatch)
            for (const [pkg, version] of Object.entries(adminDependencies)) {
              if (!workerDependencies[pkg] || workerDependencies[pkg] !== version) {
                // Install with specific version: package@version
                packagesToInstall.push(`${pkg}@${version}`);
              }
            }

            // Find packages to uninstall (in worker but not in admin)
            for (const pkg of Object.keys(workerDependencies)) {
              if (!adminDependencies[pkg]) {
                packagesToUninstall.push(pkg);
              }
            }

            log(`[ClusterStorage] Worker startup: ${packagesToInstall.length} to install, ${packagesToUninstall.length} to uninstall`);

            // Uninstall packages first
            if (packagesToUninstall.length > 0) {
              log(`[ClusterStorage] Worker startup: uninstalling ${packagesToUninstall.join(', ')}`);
              await this.packageHelper!.uninstallPackages(packagesToUninstall);
            }

            // Install new packages
            if (packagesToInstall.length > 0) {
              log(`[ClusterStorage] Worker startup: installing ${packagesToInstall.join(', ')}`);
              await this.packageHelper!.installPackages(packagesToInstall);
            }

            if (packagesToInstall.length === 0 && packagesToUninstall.length === 0) {
              log('[ClusterStorage] Worker startup: packages already in sync');
            }
          } else {
            log('[ClusterStorage] No package list found in Redis yet');
          }
        } catch (error) {
          console.error('[ClusterStorage] Error syncing packages on worker startup:', error);
          // Non-fatal error, continue with startup
        }
      }

      // Load initial package state from Redis for admin nodes
      if (this.config.role === 'admin') {
        const packagesKey = 'nodered:packages';
        const packagesData = await this.client.get(packagesKey);

        if (packagesData) {
          try {
            this.lastKnownPackages = JSON.parse(packagesData);
            log(`[ClusterStorage] Loaded ${Object.keys(this.lastKnownPackages || {}).length} existing packages from Redis`);
          } catch (error) {
            console.error('[ClusterStorage] Error loading initial package state:', error);
            // Non-fatal - just start with empty state
            this.lastKnownPackages = {};
          }
        } else {
          this.lastKnownPackages = {};
        }
      }
    }

    // Setup debug forwarding/receiving (always enabled)
    if (runtime) {
      if (this.config.role === 'worker') {
        // Worker: forward debug messages to Redis
        this.setupDebugForwarding(runtime);

        // Also hook into the log handler after nodes are loaded
        // We need to wait for nodes to be registered
        runtime.events.once('nodes-started', () => {
          this.hookDebugLogHandler(runtime);
        });
      } else if (this.config.role === 'admin') {
        // Admin: wait for flows to start before setting up debug receiver
        // runtime.comms may not be available during init()
        runtime.events.once('flows:started', () => {
          this.setupDebugReceiver(runtime).catch(err => {
            console.error('[ClusterStorage] Error setting up debug receiver:', err);
          });
        });
      }
    } else {
      console.warn('[ClusterStorage] Runtime not available, debug forwarding/receiving disabled');
    }

    // Initialize cluster monitoring (both admin and worker)
    this.clusterMonitor = new ClusterMonitor(this.client, this.config.clusterMonitoring);
    await this.clusterMonitor.initialize(this.config.role);
    log(`[ClusterStorage] Cluster monitoring initialized for ${this.config.role}`)

    // Expose cluster information directly in function node sandbox (like 'node', 'msg', 'env')
    // This requires hooking into the function node's sandbox creation
    try {
      // Create cluster object with current values
      const clusterObj = {
        type: this.config.role,
        workerId: this.clusterMonitor.getWorkerId() || 'unknown',
      };

      // Store cluster object for injection into function nodes
      // We'll hook into function node creation after nodes are loaded
      if (runtime && runtime.events) {
        runtime.events.once('nodes-started', () => {
          this.injectClusterIntoFunctionNodes(runtime, clusterObj);
        });
      }

      log(`[ClusterStorage] Cluster information will be exposed to function nodes`);
      log(`[ClusterStorage] Type: ${this.config.role}, WorkerId: ${clusterObj.workerId}`);
    } catch (error) {
      console.error('[ClusterStorage] Failed to setup cluster injection:', error);
    }

    // Note: We don't restore active project during init() because Node-RED's runtime
    // is not fully initialized yet (settings not available). The project metadata
    // is saved to Redis when a project is created/activated, but restoration is manual.
    // Flows are restored correctly regardless of project state.
  }


  /**
   * Restore active project from Redis on admin startup (OLD METHOD - kept for reference)
   * Uses Node-RED's Projects API to ensure proper project structure
   */
  private async restoreActiveProject(settings: NodeREDSettings): Promise<void> {
    log('[ClusterStorage] restoreActiveProject() called');
    try {
      // Check if there's an active project in Redis
      const activeProjectKey = this.getKey('activeProject');
      const activeProjectData = await this.client.get(activeProjectKey);

      if (!activeProjectData) {
        log('[ClusterStorage] No active project in Redis, skipping restore');
        return;
      }

      const projectMeta: ProjectMetadata = JSON.parse(activeProjectData);
      log(`[ClusterStorage] Found active project "${projectMeta.name}" in Redis`);

      if (!this.localfilesystem?.projects) {
        console.warn('[ClusterStorage] Projects API not available, cannot restore project');
        return;
      }

      // Check if project already exists
      try {
        const existingProject = await this.localfilesystem.projects.getProject(projectMeta.name);
        if (existingProject) {
          log(`[ClusterStorage] Project "${projectMeta.name}" already exists locally`);
          // Project exists, activate it if not already active
          const currentActive = this.localfilesystem.projects.getActiveProject();
          if (!currentActive || currentActive.name !== projectMeta.name) {
            log(`[ClusterStorage] Activating project "${projectMeta.name}"`);
            const adminUser = { username: 'admin', permissions: '*' };
            await this.localfilesystem.projects.setActiveProject(adminUser, projectMeta.name);
            log(`[ClusterStorage] Project "${projectMeta.name}" activated successfully`);
          } else {
            log(`[ClusterStorage] Project "${projectMeta.name}" is already active`);
          }
          return;
        }
      } catch (error) {
        // Project doesn't exist, we'll create it below
        log(`[ClusterStorage] Project "${projectMeta.name}" not found locally, will be created`);
      }

      // Get flows from Redis to initialize the project
      const flowsKey = this.getKey('flows');
      const flowsData = await this.client.get(flowsKey);

      if (!flowsData) {
        console.warn('[ClusterStorage] No flows in Redis, cannot create project');
        return;
      }

      const flowConfig: FlowConfig = await this.deserialize(flowsData);

      // Create project using Node-RED's Projects API
      // We create a minimal user object for the API call
      const adminUser = { username: 'admin', permissions: '*' };

      const projectConfig = {
        name: projectMeta.name,
        summary: 'Project restored from Redis',
        // Don't set files.flow - let Node-RED use default flow.json
        git: {
          remotes: {}
        }
      };

      log(`[ClusterStorage] Creating project "${projectMeta.name}" using Projects API`);

      try {
        // Create the project - this will create all necessary files and git repo
        await this.localfilesystem.projects.createProject(adminUser, projectConfig);
        log(`[ClusterStorage] Project created successfully`);

        // Activate the project immediately after creation
        await this.localfilesystem.projects.setActiveProject(adminUser, projectMeta.name);
        log(`[ClusterStorage] Project "${projectMeta.name}" activated`);

        // Now write the flows to the project using saveFlows
        // The flows will be saved to the project's flow.json via localfilesystem
        // localfilesystem.saveFlows expects just the flows array, not the FlowConfig object
        await this.localfilesystem.saveFlows(flowConfig.flows);
        log(`[ClusterStorage] Flows written to project`);

      } catch (createError: any) {
        console.error(`[ClusterStorage] Error creating project: ${createError.message}`);
        // If creation fails, log but continue - Node-RED will work without projects
      }

    } catch (error) {
      console.error('[ClusterStorage] Error restoring active project:', error);
      // Non-fatal - continue without project
    }
  }

  /**
   * Get flows from storage
   * Admin: reads from disk (persistent storage)
   * Worker: lazy restore from Redis, then reads from local cache
   */
  async getFlows(): Promise<FlowConfig> {
    if (this.config.role === 'admin') {
      // Admin: NEVER restore from Redis - disk is source of truth
      // Just delegate directly to localfilesystem
      if (this.localfilesystem) {
        return await this.localfilesystem.getFlows();
      }
    } else {
      // Worker: always read from Redis (no disk caching)
      const flowsKey = this.getKey('flows');
      const flowsData = await this.client.get(flowsKey);

      if (flowsData) {
        const flows = await this.deserialize<FlowConfig>(flowsData);

        // Check if we have an object with flows property (non-project mode)
        // Node-RED expects an array in non-project mode
        if (!Array.isArray(flows) && flows && typeof flows === 'object' && 'flows' in flows) {
          return (flows as any).flows;
        }

        return flows;
      }

      return [];
    }

    // Fallback if localfilesystem not available
    console.warn('[ClusterStorage] localfilesystem not available, returning empty flows');
    return { flows: [], rev: '0' };
  }

  /**
   * Save flows to storage and optionally publish update
   * Wrapper pattern: delegate to localfilesystem, then sync to Redis, then publish
   * @param skipPublish - If true, skip publishing update event (used during lazy restore)
   */
  async saveFlows(flows: FlowConfig, skipPublish = false): Promise<void> {
    const sanitized = this.sanitizeFlows(flows);

    // 1. Delegate to localfilesystem (writes file + updates memory)
    if (this.localfilesystem) {
      // localfilesystem.saveFlows expects different formats:
      // - Array when there's an active project
      // - Object {flows: [], rev: '0'} when no active project
      const activeProject = this.localfilesystem.projects?.getActiveProject?.();
      const dataToSave = sanitized.flows;

      await this.localfilesystem.saveFlows(dataToSave);
      log('[ClusterStorage] Flows saved via localfilesystem');
    } else {
      console.warn('[ClusterStorage] localfilesystem not available, skipping file write');
    }

    // 2. Sync to Redis (always to global key - active flow only)
    // Admin: sync current active flow to Redis for workers
    // Worker: should not normally save flows (read-only)
    const key = this.getKey('flows');
    const data = await this.serialize(sanitized);
    await this.client.set(key, data);
    log('[ClusterStorage] Flows synced to Redis (active flow)');

    // 4. Publish update for worker nodes (admin only)
    if (this.config.role === 'admin' && !skipPublish) {
      await this.client.publish(this.config.updateChannel, Date.now().toString());
      log(`[ClusterStorage] Published flow update to ${this.config.updateChannel}`);
    }
  }

  /**
   * Get credentials from storage
   * Admin: reads from disk (persistent storage)
   * Worker: lazy restore from Redis, then reads from local cache
   */
  async getCredentials(): Promise<CredentialsConfig> {
    if (this.config.role === 'admin') {
      // Admin: NEVER restore from Redis - disk is source of truth
      if (this.localfilesystem) {
        return (await this.localfilesystem.getCredentials()) || {};
      }
    } else {
      // Worker: always read from Redis (no disk caching)
      const credsKey = this.getKey('credentials');
      const credsData = await this.client.get(credsKey);

      if (credsData) {
        return await this.deserialize<CredentialsConfig>(credsData);
      }

      return {};
    }

    // Fallback if localfilesystem not available
    console.warn('[ClusterStorage] localfilesystem not available, returning empty credentials');
    return {};
  }

  /**
   * Save credentials to storage
   * Wrapper pattern: delegate to localfilesystem, then sync to Redis
   */
  async saveCredentials(credentials: CredentialsConfig): Promise<void> {
    // 1. Delegate to localfilesystem (writes file + updates memory)
    if (this.localfilesystem) {
      await this.localfilesystem.saveCredentials(credentials);
      log('[ClusterStorage] Credentials saved via localfilesystem');
    } else {
      console.warn('[ClusterStorage] localfilesystem not available, skipping file write');
    }

    // 2. Sync to Redis (always to global key - active credentials only)
    const key = this.getKey('credentials');
    const data = await this.serialize(credentials);
    await this.client.set(key, data);
    log('[ClusterStorage] Credentials synced to Redis (active credentials)');
  }

  /**
   * Get user settings from storage
   * Admin: reads from disk (persistent storage)
   * Worker: lazy restore from Redis, then reads from local cache
   */
  async getSettings(): Promise<UserSettings> {
    if (this.config.role === 'admin') {
      // Admin: NEVER restore from Redis - disk is source of truth
      if (this.localfilesystem) {
        return await this.localfilesystem.getSettings();
      }
    } else {
      // Worker: always read from Redis (no disk caching)
      const settingsKey = this.getKey('settings');
      const settingsData = await this.client.get(settingsKey);

      if (settingsData) {
        return await this.deserialize<UserSettings>(settingsData);
      }

      return {};
    }

    // Fallback if localfilesystem not available
    console.warn('[ClusterStorage] localfilesystem not available, returning empty settings');
    return {};
  }

  /**
   * Save user settings to storage
   * Wrapper pattern: delegate to localfilesystem, then sync to Redis, then package sync
   */
  async saveSettings(settings: UserSettings): Promise<void> {
    // Validate input
    if (!settings || typeof settings !== 'object') {
      throw new Error('[ClusterStorage] saveSettings: settings must be an object');
    }

    // 1. Delegate to localfilesystem (writes file + updates memory)
    if (this.localfilesystem) {
      await this.localfilesystem.saveSettings(settings);
      log('[ClusterStorage] Settings saved via localfilesystem');
    } else {
      console.warn('[ClusterStorage] localfilesystem not available, skipping file write');
    }

    // 2. Sync to Redis
    const key = this.getKey('settings');
    const data = await this.serialize(settings);
    await this.client.set(key, data);
    log('[ClusterStorage] Settings synced to Redis');

    // 3. Package sync: debounced to wait for package.json update (admin only)
    if (this.config.syncPackages && this.config.role === 'admin') {
      // Clear existing timer if any
      if (this.packageSyncTimer) {
        clearTimeout(this.packageSyncTimer);
      }

      log('[ClusterStorage] Scheduling package sync (debounced 500ms)...');

      // Schedule package sync after 500ms to allow package.json to be updated
      this.packageSyncTimer = setTimeout(() => {
        log('[ClusterStorage] Running debounced package sync...');
        this.handlePackageSync(settings).catch(error => {
          console.error('[ClusterStorage] Package sync failed:', error);
        });
      }, 500);
    } else {
      log('[ClusterStorage] Package sync skipped: syncPackages=' + this.config.syncPackages + ', role=' + this.config.role);
    }
  }

  /**
   * Get sessions from storage
   * Admin: reads from disk (persistent storage)
   * Worker: lazy restore from Redis, then reads from local cache
   */
  async getSessions(): Promise<SessionsConfig> {
    if (this.config.role === 'admin') {
      // Admin: NEVER restore from Redis - disk is source of truth
      if (this.localfilesystem) {
        return (await this.localfilesystem.getSessions()) || {};
      }
    } else {
      // Worker: always read from Redis (no disk caching)
      const sessionsKey = this.getKey('sessions');
      const sessionsData = await this.client.get(sessionsKey);

      if (sessionsData) {
        return await this.deserialize<SessionsConfig>(sessionsData);
      }

      return {};
    }

    // Fallback if localfilesystem not available
    console.warn('[ClusterStorage] localfilesystem not available, returning empty sessions');
    return {};
  }

  /**
   * Save sessions to storage with TTL
   */
  async saveSessions(sessions: SessionsConfig): Promise<void> {
    // 1. Delegate to localfilesystem (writes file + updates memory)
    if (this.localfilesystem) {
      await this.localfilesystem.saveSessions(sessions);
      log('[ClusterStorage] Sessions saved via localfilesystem');
    } else {
      console.warn('[ClusterStorage] localfilesystem not available, skipping file write');
    }

    // 2. Sync to Redis with TTL
    const key = this.getKey('sessions');
    const data = await this.serialize(sessions);
    await this.client.set(key, data, 'EX', this.config.sessionTTL);
    log('[ClusterStorage] Sessions synced to Redis');
  }

  /**
   * Get library entry from storage
   */
  async getLibraryEntry(type: string, path: string): Promise<LibraryEntry | LibraryEntry[]> {
    const key = this.getLibraryKey(type, path);

    // Check if it's a directory listing
    if (path.endsWith('/') || !path) {
      const pattern = `${key}*`;
      const keys = await this.client.keys(pattern);

      const entries: LibraryEntry[] = [];
      for (const k of keys) {
        const data = await this.client.get(k);
        if (data) {
          const entry = await this.deserialize<LibraryEntry>(data);
          entries.push(entry);
        }
      }
      return entries;
    }

    // Get single entry
    const data = await this.client.get(key);
    if (!data) {
      throw new Error('Library entry not found');
    }

    return await this.deserialize<LibraryEntry>(data);
  }

  /**
   * Save library entry to storage
   */
  async saveLibraryEntry(
    type: string,
    path: string,
    meta: Record<string, any>,
    body: string
  ): Promise<void> {
    const key = this.getLibraryKey(type, path);
    const entry: LibraryEntry = { ...meta, fn: body };
    const data = await this.serialize(entry);

    await this.client.set(key, data);
  }

  /**
   * Ensure data is restored from Redis on first access (lazy restore)
   * Uses localfilesystem.save*() to update both filesystem and memory
   */
  private async ensureRestored(type: 'flows' | 'credentials' | 'settings' | 'sessions'): Promise<void> {
    // Skip if already restored or localfilesystem not available
    if (!this.needsRestore[type] || !this.localfilesystem) {
      return;
    }

    try {
      // Determine the correct Redis key based on active project
      const activeProject = this.localfilesystem.projects?.getActiveProject?.();
      let key: string;

      if (activeProject?.name && (type === 'flows' || type === 'credentials')) {
        // For flows/credentials with active project, use project-specific key
        key = this.getKey(`projects:${activeProject.name}:${type}`);
        log(`[ClusterStorage] Restoring ${type} from project "${activeProject.name}"`);
      } else {
        // For settings/sessions, or flows/credentials without project, use global key
        key = this.getKey(type);
      }

      // Get data from Redis
      const dataFromRedis = await this.client.get(key);

      if (dataFromRedis) {
        const data = await this.deserialize(dataFromRedis);

        // For flows: check if there's an active project and use correct format
        if (type === 'flows') {
          const activeProject = this.localfilesystem.projects?.getActiveProject?.();
          let dataToSave: any = data;

          // If there's an active project, extract the array
          if (activeProject && data && typeof data === 'object' && 'flows' in data) {
            dataToSave = (data as any).flows;
            log(`[ClusterStorage] Restoring flows for active project: extracted array of ${Array.isArray(dataToSave) ? dataToSave.length : 'unknown'} flows`);
          } else if (!activeProject) {
            // No active project: ensure we have object format
            if (Array.isArray(data)) {
              dataToSave = { flows: data, rev: '0' };
              log(`[ClusterStorage] Restoring flows (no project): converting array to object format`);
            } else {
              log(`[ClusterStorage] Restoring flows (no project): using object format with ${(data as any)?.flows?.length || 0} flows`);
            }
          }

          // Try to save flows
          try {
            await this.localfilesystem.saveFlows(dataToSave);
            const count = Array.isArray(dataToSave) ? dataToSave.length : (dataToSave?.flows?.length || 0);
            log(`[ClusterStorage] Restored ${count} flows from Redis via localfilesystem`);
          } catch (saveError: any) {
            // If save fails (e.g., due to project state), just log and continue
            console.warn(`[ClusterStorage] Could not save flows via localfilesystem: ${saveError.message}`);
            log('[ClusterStorage] Flows will be loaded from Redis on next getFlows() call');
          }
        } else {
          // For other types (credentials, settings, sessions), restore normally
          const saveMethod =
            type === 'credentials' ? 'saveCredentials' :
            type === 'settings' ? 'saveSettings' : 'saveSessions';

          await this.localfilesystem[saveMethod](data);
          log(`[ClusterStorage] Restored ${type} from Redis via localfilesystem`);
        }
      }
    } catch (error) {
      console.error(`[ClusterStorage] Error restoring ${type} from Redis:`, error);
      // Non-fatal - continue with whatever localfilesystem has
    }

    // Mark as restored (don't try again)
    this.needsRestore[type] = false;
  }

  /**
   * Get full Redis key with prefix
   */
  public getKey(name: string): string {
    return `${this.config.keyPrefix}${name}`;
  }

  /**
   * Get library key with type and path
   */
  private getLibraryKey(type: string, path: string): string {
    return `${this.config.keyPrefix}library:${type}:${path}`;
  }

  /**
   * Sanitize and validate flows data
   * Filters out null/undefined flows and ensures valid structure
   * Handles both array format (no project) and object format (with project)
   */
  private sanitizeFlows(flowConfig: any): FlowConfig {
    if (!flowConfig || typeof flowConfig !== 'object') {
      console.warn('[ClusterStorage] Invalid flow config, returning empty');
      return { flows: [], rev: '0' };
    }

    // Handle case where flowConfig is already an array (no active project)
    // localfilesystem returns array directly when not using projects
    if (Array.isArray(flowConfig)) {
      log('[ClusterStorage] Flow config is array (no active project), converting to object format');
      return {
        flows: flowConfig.filter((flow: any) => {
          if (flow === null || flow === undefined) return false;
          if (typeof flow !== 'object') return false;
          if (!flow.id) return false;
          return true;
        }),
        rev: '0',
      };
    }

    // Handle object format (active project or Redis storage)
    let flows = flowConfig.flows;
    if (!Array.isArray(flows)) {
      console.warn('[ClusterStorage] Flow config missing flows array, initializing empty');
      flows = [];
    }

    // Filter out null/undefined entries and validate each flow has an id
    const validFlows = flows.filter((flow: any) => {
      if (flow === null || flow === undefined) {
        console.warn('[ClusterStorage] Filtered out null/undefined flow');
        return false;
      }
      if (typeof flow !== 'object') {
        console.warn('[ClusterStorage] Filtered out non-object flow:', typeof flow);
        return false;
      }
      if (!flow.id) {
        console.warn('[ClusterStorage] Filtered out flow without id:', flow);
        return false;
      }
      return true;
    });

    // Log if we filtered any flows
    if (validFlows.length !== flows.length) {
      console.warn(
        `[ClusterStorage] Sanitized flows: ${flows.length} → ${validFlows.length} (removed ${flows.length - validFlows.length} invalid entries)`
      );
    }

    // Ensure rev property exists
    const rev = flowConfig.rev || '0';

    return {
      flows: validFlows,
      rev: rev,
    };
  }

  /**
   * Serialize data with optional compression
   */
  private async serialize(data: any): Promise<string> {
    const json = JSON.stringify(data);

    if (this.config.enableCompression && json.length > 1024) {
      const compressed = await gzipAsync(Buffer.from(json));
      return `gzip:${compressed.toString('base64')}`;
    }

    return json;
  }

  /**
   * Deserialize data with optional decompression
   */
  private async deserialize<T>(data: string): Promise<T> {
    if (data.startsWith('gzip:')) {
      const compressed = Buffer.from(data.substring(5), 'base64');
      const decompressed = await gunzipAsync(compressed);
      return JSON.parse(decompressed.toString());
    }

    return JSON.parse(data);
  }

  /**
   * Setup debug message forwarding from worker to admin
   * Worker nodes don't have runtime.comms (httpAdminRoot: false)
   * Debug nodes call RED.comms.publish("debug", msg) directly via module parameter
   * Solution: Hook into RED at the module level using require.cache
   */
  private setupDebugForwarding(runtime: any): void {
    const debugChannel = this.config.debugChannel;
    const workerId = this.clusterMonitor?.getWorkerId() || os.hostname();

    try {
      // Find the RED module in require.cache
      // The debug node gets RED passed as a parameter from the main runtime
      const redPath = require.resolve('@node-red/runtime/lib/api');
      const redModule = require.cache[redPath];

      // Get the actual RED instance from runtime
      const RED = runtime;

      if (!RED) {
        console.error('[ClusterStorage] Runtime/RED not available');
        return;
      }

      // Create a stub comms object if it doesn't exist
      if (!RED.comms) {
        RED.comms = {
          publish: (topic: string, data: any, retain?: boolean) => {
            // Forward debug messages to Redis
            if (topic === 'debug') {
              const debugMessage = {
                workerId,
                timestamp: Date.now(),
                topic: 'debug',
                data
              };

              this.client.publish(debugChannel, JSON.stringify(debugMessage))
                .catch(err => console.error('[ClusterStorage] Debug forward error:', err));
            }
          }
        };

        log('[ClusterStorage] Debug forwarding enabled');
      } else {
        // RED.comms exists (admin node), hook into it
        const originalPublish = RED.comms.publish.bind(RED.comms);

        RED.comms.publish = (topic: string, data: any, retain?: boolean) => {
          // Forward debug messages to Redis
          if (topic === 'debug') {
            const debugMessage = {
              workerId,
              timestamp: Date.now(),
              topic: 'debug',
              data
            };

            this.client.publish(debugChannel, JSON.stringify(debugMessage))
              .catch(err => console.error('[ClusterStorage] Debug forward error:', err));
          }

          // Call original publish (local WebSocket)
          return originalPublish(topic, data, retain);
        };

        log('[ClusterStorage] Debug forwarding enabled');
      }
    } catch (error) {
      console.error('[ClusterStorage] Error setting up debug forwarding:', error);
    }
  }

  /**
   * Hook into the debug node's log handler after nodes are loaded
   * This intercepts node.warn() and node.error() calls
   */
  private hookDebugLogHandler(runtime: any): void {
    const debugChannel = this.config.debugChannel;
    const workerId = this.clusterMonitor?.getWorkerId() || os.hostname();

    try {
      // Find the DebugNode type in the registry
      const debugNodeType = runtime.nodes.getType('debug');
      if (!debugNodeType) return;

      // Access the DebugNode constructor's logHandler
      const DebugNodeConstructor = debugNodeType as any;
      if (!DebugNodeConstructor.logHandler) return;

      // Add our own listener to the log handler
      DebugNodeConstructor.logHandler.on('log', (msg: any) => {
        if (msg.level === runtime.log.WARN || msg.level === runtime.log.ERROR) {
          const debugMessage = {
            workerId,
            timestamp: Date.now(),
            topic: 'debug',
            data: msg
          };

          this.client.publish(debugChannel, JSON.stringify(debugMessage))
            .catch(err => console.error('[ClusterStorage] Log forward error:', err));
        }
      });

      log('[ClusterStorage] Log handler hooked');
    } catch (error) {
      console.error('[ClusterStorage] Error hooking log handler:', error);
    }
  }

  /**
   * Setup debug message receiver on admin
   * Admin subscribes to debug channel and re-injects messages into local comms using events
   */
  private async setupDebugReceiver(runtime: any): Promise<void> {
    const debugChannel = this.config.debugChannel;

    // Node-RED uses an event-based system for comms
    // The runtime comms API listens for 'comms' events and forwards them to all connections
    // This is how debug nodes internally publish messages
    if (!runtime.events) {
      console.warn('[ClusterStorage] runtime.events not available, debug receiver disabled');
      return;
    }

    this.debugSubscriber = this.client.duplicate();
    await this.debugSubscriber.subscribe(debugChannel);

    this.debugSubscriber.on('message', (channel: string, message: string) => {
      if (channel === debugChannel) {
        try {
          const debugEvent = JSON.parse(message);

          // Enhance the debug data with worker identification
          const enhancedData = {
            ...debugEvent.data,
            _sourceWorker: debugEvent.workerId,
            _workerTimestamp: debugEvent.timestamp
          };

          // If there's a 'name' field, prefix it with worker ID
          if (enhancedData.name) {
            enhancedData.name = `[${debugEvent.workerId}] ${enhancedData.name}`;
          }

          // Emit comms event - this is how Node-RED internally publishes debug messages
          // The runtime comms API will intercept this and forward to all WebSocket connections
          runtime.events.emit('comms', {
            topic: 'debug',
            data: enhancedData,
            retain: false
          });
        } catch (error) {
          console.error('[ClusterStorage] Error processing debug message:', error);
        }
      }
    });

    log('[ClusterStorage] Debug receiver enabled');
  }


  /**
   * Inject cluster object into function node sandbox
   * This makes 'cluster' available as a direct variable like 'node', 'msg', 'env'
   */
  private injectClusterIntoFunctionNodes(runtime: any, clusterObj: any): void {
    try {
      // Node-RED uses vm.Script.runInContext() to execute function node code
      // We need to monkey-patch Script.prototype.runInContext to inject cluster
      const vm = require('vm');
      const Script = vm.Script;
      const originalRunInContext = Script.prototype.runInContext;

      Script.prototype.runInContext = function(contextifiedObject: any, options?: any) {
        // Inject cluster into the context object before execution
        if (contextifiedObject && !contextifiedObject.cluster) {
          contextifiedObject.cluster = clusterObj;
        }
        return originalRunInContext.call(this, contextifiedObject, options);
      };

      log('[ClusterStorage] Cluster variable injected into function node sandbox via Script.prototype.runInContext');
    } catch (error) {
      console.error('[ClusterStorage] Error injecting cluster into function nodes:', error);
    }
  }

  /**
   * Close connections (for cleanup)
   */
  async close(): Promise<void> {
    if (this.clusterMonitor) {
      await this.clusterMonitor.stop();
    }
    if (this.packageSyncTimer) {
      clearTimeout(this.packageSyncTimer);
    }
    if (this.debugSubscriber) {
      await this.debugSubscriber.quit();
    }
    if (this.packageSubscriber) {
      await this.packageSubscriber.quit();
    }
    if (this.subscriber) {
      await this.subscriber.quit();
    }
    await this.client.quit();
  }

  /**
   * Handle package synchronization from .config.json changes
   * Throws errors to ensure data integrity - Node-RED needs to know if save fails
   */
  private async handlePackageSync(settings: UserSettings): Promise<void> {
    log('[ClusterStorage] handlePackageSync called');

    try {
      // Read package.json to get installed modules
      if (!this.packageHelper) {
        log('[ClusterStorage] No packageHelper available, skipping package sync');
        return;
      }

      const packageJsonPath = path.join(this.packageHelper.getUserDir(), 'package.json');
      let packageJson: any;
      try {
        const packageContent = await fs.readFile(packageJsonPath, 'utf8');
        packageJson = JSON.parse(packageContent);
      } catch (error) {
        log('[ClusterStorage] No package.json found, skipping package sync');
        return;
      }

      // Extract installed packages with versions from dependencies
      const dependencies: Record<string, string> = packageJson.dependencies || {};

      // Detect changes
      if (this.hasPackageChanges(dependencies)) {

        // Publish dependencies object with versions
        await this.client.publish(this.config.packageChannel, JSON.stringify(dependencies));

        // Also save to Redis for worker startup sync
        const packagesKey = 'nodered:packages';
        await this.client.set(packagesKey, JSON.stringify(dependencies));

        log(`[ClusterStorage] Published ${Object.keys(dependencies).length} package(s) to ${this.config.packageChannel}`);

        // Update known packages
        this.lastKnownPackages = dependencies;
      }
    } catch (error) {
      // Log detailed error for debugging
      console.error('[ClusterStorage] Package sync failed:', error);
      console.error('[ClusterStorage] Settings keys:', Object.keys(settings));

      // Re-throw with more context
      throw new Error(
        `Package synchronization failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Check if package dependencies have changed from last known state
   * Compares both package names and versions
   */
  private hasPackageChanges(newPackages: Record<string, string>): boolean {
    // First run - always consider as changed
    if (!this.lastKnownPackages) {
      return true;
    }

    // Get package names
    const newPackageNames = Object.keys(newPackages);
    const oldPackageNames = Object.keys(this.lastKnownPackages);

    // Different count means changes occurred
    if (newPackageNames.length !== oldPackageNames.length) {
      return true;
    }

    // Check if all packages match (name and version)
    for (const [pkg, version] of Object.entries(newPackages)) {
      if (this.lastKnownPackages[pkg] !== version) {
        return true;
      }
    }

    return false;
  }

  /**
   * Expose Projects module if localfilesystem is initialized
   */
  get projects() {
    return this.localfilesystem?.projects;
  }

  /**
   * Get cluster monitor instance for dashboard access
   */
  getClusterMonitor(): ClusterMonitor | undefined {
    return this.clusterMonitor;
  }
}
