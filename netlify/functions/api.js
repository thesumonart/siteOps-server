import serverless from 'serverless-http';
import { createApp } from '../../src/app.js';
import { connectToDatabase } from '../../src/database/connection.js';
import { env } from '../../src/config/env.js';
import { logger } from '../../src/utils/logger.js';

let isConnected = false;
let wrappedHandler;

/**
 * Lazily initialise the database connection so the cold-start only pays the
 * connection cost once — subsequent invocations of the same Lambda container
 * reuse the open pool.
 */
async function ensureConnected() {
  if (isConnected) return;
  await connectToDatabase({
    uri: env.MONGODB_URI,
    maxPoolSize: env.MONGODB_MAX_POOL_SIZE,
    autoIndex: env.MONGODB_AUTO_INDEX,
    appName: 'siteops-api-netlify',
  });
  isConnected = true;
  logger.info('database.connected');
}

/**
 * Netlify / AWS Lambda handler.
 *
 * `createApp` is called once per container; subsequent requests reuse the
 * Express instance (and its already-registered middleware stack) at no extra
 * cost. The monitoring runtime is not started here — serverless functions are
 * stateless and cannot host background loops.
 */
export const handler = async (event, context) => {
  // Prevent Lambda from waiting for the event loop to drain before returning.
  // The MongoDB driver keeps the connection alive with a timer; without this
  // flag the function would time out instead of returning a response.
  context.callbackWaitsForEmptyEventLoop = false;

  try {
    await ensureConnected();
  } catch (error) {
    logger.fatal({ err: error }, 'api.bootstrap_failed');
    return {
      statusCode: 503,
      body: JSON.stringify({ error: 'Service temporarily unavailable' }),
      headers: { 'Content-Type': 'application/json' },
    };
  }

  if (!wrappedHandler) {
    const app = createApp();
    wrappedHandler = serverless(app);
  }

  return wrappedHandler(event, context);
};
