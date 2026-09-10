import { Types } from 'mongoose';
import { describe, expect, it } from 'vitest';

import type { MonitorRunResult } from '../monitoring/monitor-runner.js';
import type { ClaimedMonitor } from '../queues/monitor.queue.js';
import { combineMonitorNotifiers, type MonitorNotifier } from './monitor-notifier.js';

const monitor = { id: new Types.ObjectId(), type: 'ssl' } as unknown as ClaimedMonitor;
const result = { status: 'failing', summary: 'Certificate expired' } as MonitorRunResult;
const incidentId = new Types.ObjectId();

function recording(calls: string[], name: string): MonitorNotifier {
  return {
    monitorProblem: () => {
      calls.push(`${name}:problem`);
      return Promise.resolve();
    },
    monitorRecovered: () => {
      calls.push(`${name}:recovered`);
      return Promise.resolve();
    },
  };
}

const failing: MonitorNotifier = {
  monitorProblem: () => Promise.reject(new Error('Mail provider is down.')),
  monitorRecovered: () => Promise.reject(new Error('Mail provider is down.')),
};

describe('combining notifiers', () => {
  it('tells every notifier about a transition', async () => {
    const calls: string[] = [];
    const combined = combineMonitorNotifiers(recording(calls, 'email'), recording(calls, 'slack'));

    await combined.monitorProblem(monitor, result, incidentId);
    await combined.monitorRecovered(monitor, result, incidentId);

    expect(calls).toEqual(['email:problem', 'slack:problem', 'email:recovered', 'slack:recovered']);
  });

  it('still tells the others when one fails, and then reports the failure', async () => {
    // An email outage must not stop the Slack message.
    const calls: string[] = [];
    const combined = combineMonitorNotifiers(failing, recording(calls, 'slack'));

    await expect(combined.monitorProblem(monitor, result, incidentId)).rejects.toThrow(
      'Mail provider is down.',
    );
    expect(calls).toEqual(['slack:problem']);
  });
});
