import { FirestoreJobQueueAdapter } from './firestoreQueueAdapter.ts';
import { EnqueueJobInput } from './types.ts';
import { ProcessingJobRecord } from '../db.ts';

async function fetchGcpMetadataAccessToken(): Promise<string> {
  const res = await fetch(
    'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token',
    { headers: { 'Metadata-Flavor': 'Google' } }
  );
  if (!res.ok) {
    throw new Error('GCP metadata server token unavailable (not running with Cloud IAM service account).');
  }
  const data: any = await res.json();
  if (!data?.access_token) throw new Error('Empty GCP metadata access_token');
  return data.access_token;
}

// Cloud Tasks Queue Adapter: keeps Firestore job ledger and pushes durable HTTP tasks to GCP Cloud Tasks API.
export class CloudTasksQueueAdapter extends FirestoreJobQueueAdapter {
  public override readonly driverName = 'cloud_tasks';

  public override async enqueue(input: EnqueueJobInput): Promise<{ job: ProcessingJobRecord; deduplicated: boolean }> {
    const queuePath = process.env.CLOUD_TASKS_QUEUE_PATH; // projects/{p}/locations/{loc}/queues/{q}
    const callbackUrl = process.env.WORKER_CALLBACK_URL;   // https://your-worker.run.app/api/internal/worker/execute
    if (!queuePath || !callbackUrl) {
      throw new Error(
        'Cloud Tasks driver selected (JOB_QUEUE_DRIVER=cloud_tasks), but CLOUD_TASKS_QUEUE_PATH and WORKER_CALLBACK_URL are not configured.'
      );
    }

    const { job, deduplicated } = await super.enqueue(input);
    if (deduplicated) return { job, deduplicated };

    const token = await fetchGcpMetadataAccessToken();
    const res = await fetch(`https://cloudtasks.googleapis.com/v2/${queuePath}/tasks`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        task: {
          httpRequest: {
            httpMethod: 'POST',
            url: callbackUrl,
            headers: { 'Content-Type': 'application/json' },
            body: Buffer.from(JSON.stringify({ jobId: job.id })).toString('base64'),
          },
        },
      }),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`Cloud Tasks enqueue failed (${res.status}): ${errText}`);
    }

    return { job, deduplicated: false };
  }
}

// Pub/Sub Queue Adapter: keeps Firestore job ledger and publishes messages to GCP Pub/Sub topic.
export class PubSubQueueAdapter extends FirestoreJobQueueAdapter {
  public override readonly driverName = 'pubsub';

  public override async enqueue(input: EnqueueJobInput): Promise<{ job: ProcessingJobRecord; deduplicated: boolean }> {
    const topicName = process.env.PUBSUB_TOPIC_NAME; // projects/{p}/topics/{t}
    if (!topicName) {
      throw new Error('Pub/Sub driver selected (JOB_QUEUE_DRIVER=pubsub), but PUBSUB_TOPIC_NAME is not configured.');
    }

    const { job, deduplicated } = await super.enqueue(input);
    if (deduplicated) return { job, deduplicated };

    const token = await fetchGcpMetadataAccessToken();
    const res = await fetch(`https://pubsub.googleapis.com/v1/${topicName}:publish`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messages: [
          {
            data: Buffer.from(JSON.stringify({ jobId: job.id, mediaId: job.mediaId, jobType: job.jobType })).toString('base64'),
            orderingKey: job.queueShard,
          },
        ],
      }),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`Pub/Sub publish failed (${res.status}): ${errText}`);
    }

    return { job, deduplicated: false };
  }
}
