import mongoose, { Schema, model, type HydratedDocument, type Model } from 'mongoose';

/**
 * Proof that a monitoring runtime is alive, written by the runtime itself.
 *
 * This collection exists because of a specific and expensive failure: the
 * monitoring worker stopped running in production and *nothing said so*. The
 * dashboard went on reporting 100% uptime and "operational" from data that was
 * eighteen hours old, which is worse than an outage — an outage is visible.
 *
 * Every write here is a fact about the runtime, never about a website, so
 * nothing in it is tenant-scoped and nothing in it is shown to a customer. It
 * is read by the operator diagnostics endpoint and by the staleness banner the
 * dashboard renders when the newest heartbeat is too old.
 *
 * One document per process instance rather than one shared row. Two instances
 * during a rolling deploy are normal and both are healthy; collapsing them onto
 * one row would let a departing instance's last write look like the survivor's.
 */
export interface WorkerHeartbeatAttributes {
  /** Random per process. The document key. */
  instanceId: string;
  /**
   * Which process hosts the loops.
   *
   * `worker` is the dedicated background process. `api` is the in-process mode
   * used where a platform offers only one long-running service — the loops are
   * identical, and naming the host is what makes a diagnostics reader able to
   * tell the two deployments apart without guessing.
   */
  host: 'api' | 'worker';
  startedAt: Date;
  /** Refreshed on every tick of any loop, and on a timer while idle. */
  lastHeartbeatAt: Date;
  /** Completion time of the most recent uptime sweep. */
  lastUptimeTickAt: Date | null;
  /** Completion time of the most recent auxiliary-monitor sweep. */
  lastMonitorTickAt: Date | null;
  lastReportTickAt: Date | null;
  /** Websites claimed by this instance since it started. */
  websitesChecked: number;
  /** Ticks that threw rather than completing. A rising number is the signal. */
  tickFailures: number;
  createdAt: Date;
  updatedAt: Date;
}

export type WorkerHeartbeatDocument = HydratedDocument<WorkerHeartbeatAttributes>;

const workerHeartbeatSchema = new Schema<WorkerHeartbeatAttributes>(
  {
    instanceId: { type: String, required: true, maxlength: 64 },
    host: { type: String, required: true, enum: ['api', 'worker'] },
    startedAt: { type: Date, required: true },
    lastHeartbeatAt: { type: Date, required: true },
    lastUptimeTickAt: { type: Date, default: null },
    lastMonitorTickAt: { type: Date, default: null },
    lastReportTickAt: { type: Date, default: null },
    websitesChecked: { type: Number, required: true, default: 0, min: 0 },
    tickFailures: { type: Number, required: true, default: 0, min: 0 },
  },
  { timestamps: true, collection: 'worker_heartbeats' },
);

// The upsert key. Unique so two writes from one instance can never race into
// two documents and make one process look like two healthy ones.
workerHeartbeatSchema.index(
  { instanceId: 1 },
  { unique: true, name: 'worker_heartbeat_instance_unique' },
);

/*
 * Diagnostics reads "the newest heartbeat", which is this index descending.
 *
 * It also carries the TTL. A week is long enough that a worker dead since
 * Friday is still visibly dead on Monday — the whole point of the collection —
 * and short enough that instance documents from months of deploys do not
 * accumulate. Expiry is on the heartbeat rather than on creation so a
 * long-lived healthy instance is never reaped while it is still writing.
 */
workerHeartbeatSchema.index(
  { lastHeartbeatAt: -1 },
  { name: 'worker_heartbeat_recent', expireAfterSeconds: 7 * 24 * 60 * 60 },
);

export const WorkerHeartbeatModel: Model<WorkerHeartbeatAttributes> =
  (mongoose.models.WorkerHeartbeat as Model<WorkerHeartbeatAttributes> | undefined) ??
  model<WorkerHeartbeatAttributes>('WorkerHeartbeat', workerHeartbeatSchema);
