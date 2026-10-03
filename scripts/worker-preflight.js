'use strict';

const REQUIRED_SECRETS = Object.freeze(['SUPABASE_URL', 'SUPABASE_SERVICE_KEY']);

function isSet(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function inspectWorkerConfig(env = process.env) {
  const missingRequired = REQUIRED_SECRETS.filter((name) => !isSet(env[name]));
  const invalidRequired = [];
  const supabaseUrl = isSet(env.SUPABASE_URL) ? env.SUPABASE_URL.trim() : '';

  if (supabaseUrl) {
    try {
      const parsed = new URL(supabaseUrl);
      if (parsed.protocol !== 'https:' || !parsed.hostname || parsed.username || parsed.password) {
        invalidRequired.push('SUPABASE_URL');
      }
    } catch {
      invalidRequired.push('SUPABASE_URL');
    }
  }

  const optionalUnavailable = [];
  if (String(env.IMAGE_IMG2IMG_PROVIDER || '').trim().toLowerCase() === 'huggingface' && !isSet(env.HF_TOKEN)) {
    optionalUnavailable.push('HF_TOKEN');
  }
  if (!isSet(env.VOICE_STUDIO_API_URL)) optionalUnavailable.push('VOICE_STUDIO_API_URL');

  return { missingRequired, invalidRequired, optionalUnavailable };
}

function runWorkerPreflight({ env = process.env, logger = console } = {}) {
  const report = inspectWorkerConfig(env);
  const validateOnly = String(env.WORKER_VALIDATE_ONLY || '').toLowerCase() === 'true';

  for (const name of report.optionalUnavailable) {
    if (name === 'HF_TOKEN') {
      logger.warn('Optional provider unavailable: missing HF_TOKEN; existing_asset fallback remains enabled.');
    } else {
      logger.warn(`Optional integration unavailable: ${name} is not configured.`);
    }
  }

  if (report.invalidRequired.length > 0) {
    for (const name of report.invalidRequired) {
      logger.error(`Invalid Worker configuration: ${name} (an HTTPS URL is required).`);
    }
    logger.error('Worker preflight failed; no secret values were displayed.');
    return 1;
  }

  if (report.missingRequired.length > 0) {
    const emit = validateOnly ? logger.warn : logger.error;
    for (const name of report.missingRequired) {
      emit(`Missing required GitHub Actions secret: ${name}`);
    }
    if (!validateOnly) {
      logger.error('Worker production run blocked; configure the listed secrets or use validate_only for a no-service smoke test.');
      return 1;
    }
  }

  if (validateOnly) {
    logger.log('Validation-only mode: configuration checks completed; the Worker must not be started.');
    return 0;
  }

  logger.log('Worker preflight passed; secret values were not displayed.');
  return 0;
}

if (require.main === module) {
  process.exitCode = runWorkerPreflight();
}

module.exports = { REQUIRED_SECRETS, inspectWorkerConfig, runWorkerPreflight };
